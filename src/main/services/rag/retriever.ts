import type { RetrievedChunk } from '../../../shared/types'
import { chunksByIds, searchChunksByKeyword } from '../knowledge/repo'
import { embedOne, type EmbeddingDeps } from './embedder'
import { searchVectors } from './vectorStore'
import { buildQueryTerms, lexicalBoost, reciprocalRankFusion } from './hybrid'

/**
 * 检索器（M3 纯向量 → M4 混合检索）
 *
 * M4 流水线：问题文本
 *   ├─ embedding → HNSW 向量召回 top 20（语义相似）
 *   └─ trigram FTS5 BM25 关键词召回 top 20（字面精确）
 *         → RRF 融合（只认排名，免疫两种分数尺度差异）
 *         → 词法特征重排（覆盖率/精确短语/标题命中）
 *         → 取 topK → SQLite 回填原文
 *
 * 开关：settings.hybridSearchEnabled=false 或查询短于 3 字时，
 * 退化为 M3 纯向量路径。
 */

/** 最终注入 prompt / 展示的条数（PRD 14.3 引用上限取 6） */
export const DEFAULT_TOP_K = 6
/** 每路召回的候选池大小：先宽召回，融合重排后再截断 */
const RECALL_CANDIDATES = 20

export async function retrieve(
  query: string,
  kbId: string,
  deps: EmbeddingDeps,
  topK: number = DEFAULT_TOP_K
): Promise<RetrievedChunk[]> {
  // 空问题不检索（trim 后），交给上层做参数校验更合适，这里再兜一层
  if (!query.trim()) return []

  const terms = buildQueryTerms(query)

  // 1. 向量路（语义召回，始终执行）
  const queryVector = await embedOne(query, deps)
  const vectorHits = await searchVectors(kbId, queryVector, RECALL_CANDIDATES)

  // 2. 关键词路（开关关闭 / 查询太短无词元 / FTS 异常时降级跳过）
  const hybridOn = deps.settings.hybridSearchEnabled !== false
  let keywordHits: ReturnType<typeof searchChunksByKeyword> = []
  if (hybridOn && terms) {
    try {
      keywordHits = searchChunksByKeyword(kbId, terms.matchExpr, RECALL_CANDIDATES)
    } catch (e) {
      // 检索是问答主链路的一环，词法索引出问题不能拖死整轮：降级纯向量
      console.warn('[retriever] 关键词召回失败，降级纯向量：', e)
    }
  }

  if (vectorHits.length === 0 && keywordHits.length === 0) return []

  const distanceByChunk = new Map(vectorHits.map((h) => [h.chunkId, h.distance]))

  // 3. 纯向量快路径（与 M3 行为一致：召回 20 截前 topK）
  if (keywordHits.length === 0) {
    const chunks = chunksByIds(vectorHits.slice(0, topK).map((h) => h.chunkId))
    return chunks.map((chunk) => ({
      ...chunk,
      distance: distanceByChunk.get(chunk.id) ?? Number.POSITIVE_INFINITY
    }))
  }

  // 4. RRF 融合 + 词法重排
  const fused = reciprocalRankFusion(
    vectorHits.map((h) => h.chunkId),
    keywordHits.map((h) => h.chunk.id)
  )
  const fusedById = new Map(fused.map((f) => [f.chunkId, f]))

  // 一次 IN 查询回填并集，再按融合分排序（chunksByIds 保序的入参顺序即 fused 顺序）
  const chunks = chunksByIds(fused.map((f) => f.chunkId))
  return chunks
    .map((chunk) => {
      const f = fusedById.get(chunk.id)
      const boost = terms
        ? lexicalBoost(chunk.content, chunk.meta.headingPath, terms)
        : 0
      return {
        chunk,
        finalScore: (f?.rrf ?? 0) + boost
      }
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK)
    .map(({ chunk }) => ({
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
