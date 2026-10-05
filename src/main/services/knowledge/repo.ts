import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/sqlite'
import type {
  ChunkInfo,
  ChunkMeta,
  DocStatus,
  DocumentInfo,
  KnowledgeBaseInfo
} from '../../../shared/types'

/**
 * 知识库 / 文档 / 片段仓储（PRD 第 12 章三张表）。
 * 与 conversations/repo.ts 同约定：这里是唯一做"SQL 行 ↔ 领域对象"
 * snake_case 转换的地方。
 */

interface KbRow {
  id: string
  name: string
  created_at: number
  doc_count: number
}

interface DocRow {
  id: string
  kb_id: string
  file_name: string
  file_hash: string | null
  status: string
  chunk_count: number
  error: string | null
  created_at: number
}

interface ChunkRow {
  id: string
  document_id: string
  chunk_index: number
  content: string
  token_count: number | null
  meta: string | null
  doc_name?: string | null
}

const DEFAULT_KB_NAME = '默认知识库'

// ---------------- knowledge_base ----------------

export function listKbs(): KnowledgeBaseInfo[] {
  // docCount 聚合：连 LEFT JOIN 一次查出，避免 N+1
  const rows = getDb()
    .prepare(
      `SELECT kb.id, kb.name, kb.created_at,
              COUNT(d.id) AS doc_count
         FROM knowledge_base kb
         LEFT JOIN document d ON d.kb_id = kb.id
        GROUP BY kb.id
        ORDER BY kb.created_at`
    )
    .all() as KbRow[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    docCount: r.doc_count
  }))
}

export function createKb(name: string): KnowledgeBaseInfo {
  const id = randomUUID()
  const createdAt = Date.now()
  getDb()
    .prepare('INSERT INTO knowledge_base(id, name, created_at) VALUES(?, ?, ?)')
    .run(id, name.trim() || '未命名知识库', createdAt)
  return { id, name: name.trim() || '未命名知识库', createdAt, docCount: 0 }
}

/**
 * 首次使用知识库时自动兜底建一个默认库（UI 无需先引导用户"新建"）。
 */
export function ensureDefaultKb(): KnowledgeBaseInfo {
  const existing = getDb()
    .prepare('SELECT id FROM knowledge_base ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (existing) {
    return listKbs().find((k) => k.id === existing.id)!
  }
  return createKb(DEFAULT_KB_NAME)
}

export function deleteKb(kbId: string): void {
  // document/chunk 由 ON DELETE CASCADE 连带删除（foreign_keys=ON）
  getDb().prepare('DELETE FROM knowledge_base WHERE id = ?').run(kbId)
}

// ---------------- document ----------------

export function insertDoc(input: {
  kbId: string
  fileName: string
  fileHash: string | null
}): DocumentInfo {
  const id = randomUUID()
  const createdAt = Date.now()
  getDb()
    .prepare(
      `INSERT INTO document(id, kb_id, file_name, file_hash, status, chunk_count, error, created_at)
       VALUES(?, ?, ?, ?, 'parsing', 0, NULL, ?)`
    )
    .run(id, input.kbId, input.fileName, input.fileHash, createdAt)
  return {
    id,
    kbId: input.kbId,
    fileName: input.fileName,
    fileHash: input.fileHash,
    status: 'parsing',
    chunkCount: 0,
    error: null,
    createdAt
  }
}

export function listDocs(kbId: string): DocumentInfo[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kb_id, file_name, file_hash, status, chunk_count, error, created_at
         FROM document WHERE kb_id = ? ORDER BY created_at DESC`
    )
    .all(kbId) as DocRow[]
  return rows.map(toDocInfo)
}

export function getDoc(docId: string): DocumentInfo | null {
  const row = getDb()
    .prepare(
      `SELECT id, kb_id, file_name, file_hash, status, chunk_count, error, created_at
         FROM document WHERE id = ?`
    )
    .get(docId) as DocRow | undefined
  return row ? toDocInfo(row) : null
}

export function updateDocStatus(
  docId: string,
  status: DocStatus,
  chunkCount?: number,
  error?: string | null
): void {
  getDb()
    .prepare(
      `UPDATE document
          SET status = ?,
              chunk_count = COALESCE(?, chunk_count),
              error = ?
        WHERE id = ?`
    )
    .run(status, chunkCount ?? null, error ?? null, docId)
}

export function deleteDoc(docId: string): void {
  // chunk 由外键 CASCADE 连带删除；向量索引的 label 由上层 vectorStore 先移除
  getDb().prepare('DELETE FROM document WHERE id = ?').run(docId)
}

// ---------------- chunk ----------------

export interface NewChunk {
  id: string
  content: string
  tokenCount: number | null
  meta: ChunkMeta
}

/**
 * 批量写入一个文档的全部片段（单事务）。
 * id 由上层 indexing 生成：HNSW label 映射必须先知道 chunkId。
 */
export function insertChunks(docId: string, chunks: NewChunk[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO chunk(id, document_id, chunk_index, content, token_count, meta)
     VALUES(?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((items: NewChunk[]) => {
    items.forEach((c, i) => {
      stmt.run(c.id, docId, i, c.content, c.tokenCount, JSON.stringify(c.meta))
    })
  })
  tx(chunks)
}

export function getChunk(chunkId: string): ChunkInfo | null {
  const row = getDb()
    .prepare(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, c.token_count, c.meta,
              d.file_name AS doc_name
         FROM chunk c JOIN document d ON d.id = c.document_id
        WHERE c.id = ?`
    )
    .get(chunkId) as ChunkRow | undefined
  return row ? toChunkInfo(row) : null
}

/**
 * 按给定 id 顺序回填片段（检索结果必须保持 HNSW 返回的相关度顺序）。
 * 用 IN (?,?...) 一次查回，再在内存按 ids 顺序重排。
 */
export function chunksByIds(ids: string[]): ChunkInfo[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, c.token_count, c.meta,
              d.file_name AS doc_name
         FROM chunk c JOIN document d ON d.id = c.document_id
        WHERE c.id IN (${placeholders})`
    )
    .all(...ids) as ChunkRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is ChunkRow => Boolean(r))
    .map(toChunkInfo)
}

export function listChunksOfDoc(
  docId: string,
  limit = 10000
): Array<ChunkInfo & { chunkIndex: number }> {
  const rows = getDb()
    .prepare(
      `SELECT id, document_id, chunk_index, content, token_count, meta
         FROM chunk WHERE document_id = ? ORDER BY chunk_index LIMIT ?`
    )
    .all(docId, limit) as ChunkRow[]
  return rows.map(toChunkInfo)
}

// ---------------- row 映射 ----------------

function toDocInfo(r: DocRow): DocumentInfo {
  return {
    id: r.id,
    kbId: r.kb_id,
    fileName: r.file_name,
    fileHash: r.file_hash,
    status: r.status as DocStatus,
    chunkCount: r.chunk_count,
    error: r.error,
    createdAt: r.created_at
  }
}

function toChunkInfo(r: ChunkRow): ChunkInfo {
  return {
    id: r.id,
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    tokenCount: r.token_count,
    meta: r.meta ? (JSON.parse(r.meta) as ChunkMeta) : {},
    docName: r.doc_name ?? undefined
  }
}

export function newChunkId(): string {
  return randomUUID()
}
