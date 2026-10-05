import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { KbEvent } from '../../../shared/protocol'
import {
  deleteDoc,
  getDoc,
  insertChunks,
  insertDoc,
  listChunksOfDoc,
  listDocs,
  newChunkId,
  updateDocStatus
} from '../knowledge/repo'
import { parseDocument } from './parser'
import { chunkDocument, type RawChunk } from './chunker'
import { embedMany, type EmbeddingDeps } from './embedder'
import { appendVectors, deleteKbIndex, removeVectors } from './vectorStore'

/**
 * 索引编排（PRD F-C1/F-C2）：把 parser → chunker → embedder → vectorStore
 * 四步串成一条文档流水线，并负责数据库状态机与 kb 事件推送。
 *
 * 文档状态机：parsing（落库即此态）→ ready / failed。
 * 渲染端通过 KbEvent 增量感知，不需要轮询。
 */

export type EmitKbEvent = (event: KbEvent) => void

export interface ImportOutcome {
  /** 内容 hash 与库内已有文档相同而跳过的文件名 */
  skipped: string[]
}

/**
 * 批量导入：逐个串行处理（embedding 推理与索引写入都不适合并发），
 * 单文档失败不影响其他文档。
 */
export async function importDocuments(
  kbId: string,
  filePaths: string[],
  deps: EmbeddingDeps,
  emit: EmitKbEvent
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { skipped: [] }
  const knownHashes = new Set(
    listDocs(kbId)
      .map((d) => d.fileHash)
      .filter((h): h is string => Boolean(h))
  )

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath)
    let docId: string | null = null
    try {
      const fileBuffer = await readFile(filePath)
      const fileHash = createHash('sha256').update(fileBuffer).digest('hex')

      // 同库内容去重（PRD file_hash 用途）：跳过但告知 UI 原因
      if (knownHashes.has(fileHash)) {
        outcome.skipped.push(fileName)
        continue
      }

      const doc = insertDoc({ kbId, fileName, fileHash })
      docId = doc.id
      emit({
        type: 'doc_enqueued',
        kbId,
        docId: doc.id,
        fileName: doc.fileName,
        status: 'parsing',
        chunkCount: 0,
        createdAt: doc.createdAt
      })

      // 1) 解析 → 2) 切分
      const parsed = await parseDocument(filePath)
      const rawChunks = chunkDocument(parsed)
      if (rawChunks.length === 0) {
        throw new Error('未能从文件中提取到任何文本，文件可能是扫描件图片或内容为空。')
      }

      // 3) 向量化（缓存命中时不产生请求）
      const vectors = await embedMany(
        rawChunks.map((c) => c.content),
        deps
      )

      // 4) chunk 落库（单事务）+ 向量入索引（共用同一批 id）
      const chunksWithIds = rawChunks.map((raw: RawChunk) => ({
        id: newChunkId(),
        content: raw.content,
        tokenCount: raw.tokenCount,
        meta: raw.meta
      }))
      insertChunks(doc.id, chunksWithIds)
      await appendVectors(
        kbId,
        chunksWithIds.map((c, i) => ({ chunkId: c.id, vector: vectors[i] }))
      )

      updateDocStatus(doc.id, 'ready', chunksWithIds.length, null)
      knownHashes.add(fileHash)
      emit({
        type: 'doc_result',
        kbId,
        docId: doc.id,
        status: 'ready',
        chunkCount: chunksWithIds.length
      })
    } catch (err) {
      const message = (err as Error).message || String(err)
      // 失败也落状态：failed 文档不进向量索引，检索永远不会命中它
      if (docId) updateDocStatus(docId, 'failed', undefined, message)
      emit({
        type: 'doc_result',
        kbId,
        docId: docId ?? '',
        status: 'failed',
        error: message
      })
    }
  }

  emit({ type: 'import_finished', kbId })
  return outcome
}

/**
 * 删除文档：先按 chunk id 从 HNSW 摘除向量，再删文档行（chunk 由
 * 外键 CASCADE 连带删除）。顺序不能反——文档删了就拿不到 chunk id。
 */
export async function removeDocument(
  docId: string,
  emit: EmitKbEvent
): Promise<void> {
  const doc = getDoc(docId)
  if (!doc) return

  const chunkIds = listChunksOfDoc(docId).map((c) => c.id)
  await removeVectors(doc.kbId, chunkIds)
  deleteDoc(docId)
  emit({ type: 'doc_removed', kbId: doc.kbId, docId })
}

/**
 * 重建整个知识库的向量索引（F-C2：更换 embedding 模型/维度后使用）。
 *
 * 范围说明：重建的是"向量"——chunk 文本不变，重新 embedding 全部
 * ready 文档的片段并重建 HNSW；embedder 按 模型名+文本 hash 缓存，
 * 同模型重建几乎零请求，换模型则全量重算。重新解析/切分不属于此操作。
 */
export async function reindexKb(
  kbId: string,
  deps: EmbeddingDeps
): Promise<{ docCount: number; chunkCount: number }> {
  await deleteKbIndex(kbId)

  const docs = listDocs(kbId).filter((d) => d.status === 'ready')
  let chunkCount = 0

  for (const doc of docs) {
    const chunks = listChunksOfDoc(doc.id)
    if (chunks.length === 0) continue
    const vectors = await embedMany(
      chunks.map((c) => c.content),
      deps
    )
    await appendVectors(
      kbId,
      chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] }))
    )
    chunkCount += chunks.length
  }

  return { docCount: docs.length, chunkCount }
}
