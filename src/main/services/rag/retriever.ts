import type { RetrievedChunk } from '../../../shared/types'
import { chunksByIds } from '../knowledge/repo'
import { embedOne, type EmbeddingDeps } from './embedder'
import { searchVectors } from './vectorStore'

/**
 * 检索器（M3：纯向量召回；M4 在此叠加 BM25 + RRF + rerank）
 *
 * 流水线：问题文本 → embedding → HNSW 取 topK 个整数 label →
 * 映射回 chunkId → SQLite 回填原文（保持相关度顺序）。
 *
 * 接口刻意收窄为 retrieve()：M4 只需要在函数内部增加混合召回与重排，
 * 上层 chat 编排零改动。
 */

/** M3 纯向量阶段取 6 条（PRD M4 混合检索阶段再细化候选与精排参数） */
export const DEFAULT_TOP_K = 6

export async function retrieve(
  query: string,
  kbId: string,
  deps: EmbeddingDeps,
  topK: number = DEFAULT_TOP_K
): Promise<RetrievedChunk[]> {
  // 空问题不检索（trim 后），交给上层做参数校验更合适，这里再兜一层
  if (!query.trim()) return []

  const queryVector = await embedOne(query, deps)
  const hits = await searchVectors(kbId, queryVector, topK)
  if (hits.length === 0) return []

  // IN 查询回填后按 HNSW 的相关度顺序重排（仓储层保证）
  const chunks = chunksByIds(hits.map((h) => h.chunkId))
  const distanceByChunk = new Map(hits.map((h) => [h.chunkId, h.distance]))

  return chunks.map((chunk) => ({
    ...chunk,
    distance: distanceByChunk.get(chunk.id) ?? Number.POSITIVE_INFINITY
  }))
}

/** 引用卡片/事件用的短摘要：去换行、限长，完整内容仍可通过 kb:chunk 查看 */
export function snippetOf(content: string, max = 120): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * RAG 系统提示词（严格按 PRD 14.3 模板）。
 *
 * 设计要点（参考经验：问答模式与 Agent 模式不能混）：
 * - 这是"知识库问答"，不是工具调用 Agent：不写"必须先调工具"之类约束，
 *   模型只需要在给定资料内回答并标注编号引用。
 * - 强约束三点：只依据资料 / 编号引用 / 无依据直接说不知道。
 * - 编号 [1..n] 与检索结果数组顺序严格一致，citation 事件按同序发送，
 *   渲染端行内 [1] 才能和引用卡片对上号。
 */
export function buildRagSystemPrompt(
  baseSystemPrompt: string,
  chunks: RetrievedChunk[]
): string {
  const references = chunks
    .map((chunk, i) => {
      const sourceParts = [chunk.docName ?? '未命名文档']
      if (typeof chunk.meta.page === 'number' && chunk.meta.page !== null) {
        sourceParts.push(`第 ${chunk.meta.page} 页`)
      }
      if (chunk.meta.headingPath) sourceParts.push(chunk.meta.headingPath)
      return `[${i + 1}] 来源：${sourceParts.join(' · ')}\n内容：${chunk.content}`
    })
    .join('\n\n')

  return `${baseSystemPrompt.trim()}

你正在以「知识库问答」模式回答用户问题。请严格根据下面提供的参考资料回答。
要求：
1. 只能依据参考资料中的内容回答，不得编造资料之外的信息；
2. 当回答使用了某条资料时，在相应句子末尾用 [1][2] 这样的编号标注来源，编号对应下面的资料序号；
3. 若资料中没有与问题相关的内容，直接回答"抱歉，知识库中未找到相关信息。"，不要硬答；
4. 回答保持简洁，不要罗列无关资料。

参考资料：
${references}`
}
