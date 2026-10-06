import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/sqlite'
import type {
  ChunkBackup,
  ChunkInfo,
  ChunkMeta,
  DocStatus,
  DocumentBackup,
  DocumentInfo,
  KbBackup,
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
  const db = getDb()
  const tx = db.transaction(() => {
    // FTS 虚表不参与外键 CASCADE，必须手动清（顺序：先 FTS 再删 chunk/document）
    db.prepare(
      `DELETE FROM chunk_fts
        WHERE chunk_id IN (
          SELECT c.id FROM chunk c
            JOIN document d ON d.id = c.document_id
           WHERE d.kb_id = ?
        )`
    ).run(kbId)
    // document/chunk 由 ON DELETE CASCADE 连带删除（foreign_keys=ON）
    db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(kbId)
  })
  tx()
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
  const db = getDb()
  // 事务保证"清 FTS + 删文档"原子：chunk 行由外键 CASCADE 连带删除，
  // 但 FTS 是独立虚表，不会跟着删，漏掉就会搜到已删除文档的幽灵片段
  const tx = db.transaction(() => {
    db.prepare(
      'DELETE FROM chunk_fts WHERE chunk_id IN (SELECT id FROM chunk WHERE document_id = ?)'
    ).run(docId)
    db.prepare('DELETE FROM document WHERE id = ?').run(docId)
  })
  tx()
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
  // 同一事务同步写 FTS：与 chunk 行同生共死，不会出现"能搜到但取不出"
  const ftsStmt = db.prepare(
    'INSERT INTO chunk_fts(content, chunk_id) VALUES(?, ?)'
  )
  const tx = db.transaction((items: NewChunk[]) => {
    items.forEach((c, i) => {
      stmt.run(c.id, docId, i, c.content, c.tokenCount, JSON.stringify(c.meta))
      ftsStmt.run(c.content, c.id)
    })
  })
  tx(chunks)
}

export interface KeywordHit {
  chunk: ChunkInfo
  /** FTS5 内置 BM25 原始分：值越小（越负）越相关 */
  bm25: number
}

/**
 * 关键词召回（M4 混合检索的一路）：FTS5 trigram + 内置 BM25 排序。
 *
 * @param matchExpr 已经过转义/构造的 MATCH 表达式（见 hybrid.buildFtsMatch），
 *                  绝不直接拼用户原始输入（引号等 FTS 语法字符会注入）
 *
 * 注意 AND 优先级（参考经验）：MATCH 与 kb 库过滤是同一 WHERE 下的两个
 * 合取支，FTS 先按索引召回、JOIN document 后再限定 kb 范围，
 * 不存在 OR 冲掉库过滤的问题。
 */
export function searchChunksByKeyword(
  kbId: string,
  matchExpr: string,
  limit: number
): KeywordHit[] {
  if (limit <= 0) return []
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.document_id, c.chunk_index, c.content, c.token_count, c.meta,
              d.file_name AS doc_name, bm25(chunk_fts) AS bm25
         FROM chunk_fts
         JOIN chunk c ON c.id = chunk_fts.chunk_id
         JOIN document d ON d.id = c.document_id
        WHERE chunk_fts MATCH ? AND d.kb_id = ?
        ORDER BY bm25
        LIMIT ?`
    )
    .all(matchExpr, kbId, limit) as Array<ChunkRow & { bm25: number }>
  return rows.map((r) => ({ chunk: toChunkInfo(r), bm25: r.bm25 }))
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

// ---------------- 全量备份导出 / 导入 ----------------

/** 导出全部知识库（文档 + 片段文本/FTS 源）。向量索引不导出（可重建）。 */
export function exportKbsForBackup(): KbBackup[] {
  const db = getDb()
  const kbRows = db
    .prepare('SELECT id, name, created_at FROM knowledge_base ORDER BY created_at')
    .all() as Array<{ id: string; name: string; created_at: number }>
  const docRows = db
    .prepare(
      `SELECT id, kb_id, file_name, file_hash, status, chunk_count, error, created_at
         FROM document ORDER BY created_at`
    )
    .all() as Array<{
    id: string
    kb_id: string
    file_name: string
    file_hash: string | null
    status: string
    chunk_count: number
    error: string | null
    created_at: number
  }>
  const chunkRows = db
    .prepare(
      'SELECT id, document_id, chunk_index, content, token_count, meta FROM chunk ORDER BY document_id, chunk_index'
    )
    .all() as Array<{
    id: string
    document_id: string
    chunk_index: number
    content: string
    token_count: number | null
    meta: string | null
  }>

  const chunksByDoc = new Map<string, ChunkBackup[]>()
  for (const c of chunkRows) {
    const list = chunksByDoc.get(c.document_id) ?? []
    list.push({
      id: c.id,
      chunkIndex: c.chunk_index,
      content: c.content,
      tokenCount: c.token_count,
      meta: c.meta
    })
    chunksByDoc.set(c.document_id, list)
  }

  const docsByKb = new Map<string, DocumentBackup[]>()
  for (const d of docRows) {
    const list = docsByKb.get(d.kb_id) ?? []
    list.push({
      id: d.id,
      fileName: d.file_name,
      fileHash: d.file_hash,
      status: d.status,
      chunkCount: d.chunk_count,
      error: d.error,
      createdAt: d.created_at,
      chunks: chunksByDoc.get(d.id) ?? []
    })
    docsByKb.set(d.kb_id, list)
  }

  return kbRows.map((k) => ({
    id: k.id,
    name: k.name,
    createdAt: k.created_at,
    documents: docsByKb.get(k.id) ?? []
  }))
}

/**
 * 导回一个知识库（文档/片段/FTS 同步恢复，保留原 id 以维持
 * 会话消息 citation 的引用有效）。
 * 向量索引不随备份迁移：语义检索需之后对该库执行一次"重建索引"。
 * @returns 导入计数；null 表示同 id 库已存在，整组跳过
 */
export function importKbBackup(
  kb: KbBackup
): { documents: number; chunks: number } | null {
  const db = getDb()
  const exists = db
    .prepare('SELECT id FROM knowledge_base WHERE id = ?')
    .get(kb.id) as { id: string } | undefined
  if (exists) return null

  let documents = 0
  let chunks = 0
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO knowledge_base(id, name, created_at) VALUES(?, ?, ?)'
    ).run(kb.id, kb.name, kb.createdAt)

    const insertDoc = db.prepare(
      `INSERT INTO document(id, kb_id, file_name, file_hash, status, chunk_count, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertChunk = db.prepare(
      `INSERT INTO chunk(id, document_id, chunk_index, content, token_count, meta)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // 与 insertChunks 同约定：chunk 行与 FTS 同事务双写
    const insertFts = db.prepare(
      'INSERT INTO chunk_fts(content, chunk_id) VALUES(?, ?)'
    )
    for (const d of kb.documents) {
      insertDoc.run(
        d.id,
        kb.id,
        d.fileName,
        d.fileHash,
        d.status,
        d.chunkCount,
        d.error,
        d.createdAt
      )
      documents += 1
      for (const c of d.chunks) {
        insertChunk.run(c.id, d.id, c.chunkIndex, c.content, c.tokenCount, c.meta)
        insertFts.run(c.content, c.id)
        chunks += 1
      }
    }
  })
  tx()
  return { documents, chunks }
}
