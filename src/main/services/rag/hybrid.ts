/**
 * 混合检索纯函数层（M4）：FTS 查询构造 / RRF 融合 / 轻量词法重排。
 *
 * 为什么单独成文件：这三件事都是不碰 I/O 的纯逻辑，可单测、可复用；
 * retriever.ts 只负责把它们和 embedder/vectorStore/仓储串起来。
 *
 * 整体管线（PRD M4 混合检索）：
 *   查询 ──┬─ embedding → HNSW 向量召回（语义：同义、近义、跨语言）
 *         └─ trigram FTS5 BM25 关键词召回（字面：型号、编号、罕见专名）
 *                    ↓ RRF 融合（只认排名，不需要对齐两种分数尺度）
 *                    ↓ 词法特征重排（覆盖率/精确短语/标题命中加权）
 *                    ↓ topK
 */

// ---------------- 查询词解析 ----------------

const CJK_RE = /[\u4e00-\u9fff]+/g
const ASCII_WORD_RE = /[a-z0-9][a-z0-9._+-]{1,}[a-z0-9]|[a-z0-9]{3,}/g
/** trigram 分词器最短匹配单元是 3 个字符，FTS 原子总数封顶防超长查询 */
const MIN_GRAM = 3
const MAX_ATOMS = 64

export interface QueryTerms {
  /** 可直接绑定给 chunk_fts MATCH 的表达式（原子全部双引号包裹，OR 连接） */
  matchExpr: string
  /** 去重后的中文三元组，重排时算覆盖率 */
  trigrams: string[]
  /** 可做"精确出现"加分的短语：英文单词（≥3）/ 中文连续段（≥2） */
  phrases: string[]
}

/**
 * 把自然语言查询翻译成 trigram FTS 能吃的 MATCH 表达式。
 *
 * 关键点（实测得出）：
 * - trigram 只索引 ≥3 字符的单元，"闷蒸"这类 2 字词 FTS 无法召回（留给向量路）
 * - 中文长句整串加引号等于要求连续子串，"二氧化碳排出" 匹配不到
 *   "二氧化碳充分排出"——必须切成滑动三元组再 OR，靠 BM25 按命中数排序
 * - 原子一律双引号包裹：用户输入里的 FTS 语法字符（" * : ( ) ^ 等）
 *   先被正则白名单过滤，杜绝 MATCH 注入
 *
 * @returns 无可用词元（查询太短）时返回 null，调用方跳过关键词路
 */
export function buildQueryTerms(rawQuery: string): QueryTerms | null {
  const query = rawQuery.toLowerCase().trim()
  if (query.length < MIN_GRAM) return null

  const atoms = new Set<string>()
  const trigrams = new Set<string>()
  const phrases: string[] = []

  // 英文/数字词：本身就是一个 trigram 短语（"bm25" 命中含该子串的片段）
  for (const word of query.match(ASCII_WORD_RE) ?? []) {
    if (word.length >= MIN_GRAM) {
      atoms.add(word)
      phrases.push(word)
    }
  }

  // 中文连续段：滑动三元组（OR 召回），≥2 的整段留给精确短语加分
  for (const run of query.match(CJK_RE) ?? []) {
    if (run.length >= 2) phrases.push(run)
    for (let i = 0; i + MIN_GRAM <= run.length; i++) {
      trigrams.add(run.slice(i, i + MIN_GRAM))
    }
  }

  trigrams.forEach((t) => atoms.add(t))

  const atomList = [...atoms].slice(0, MAX_ATOMS)
  if (atomList.length === 0) return null

  // 每个原子双引号转义（白名单已保证不含引号），OR 连接走召回优先，
  // 精确排序交给 BM25 + RRF + 重排，而不是在召回阶段做 AND 收紧
  return {
    matchExpr: atomList.map((a) => `"${a}"`).join(' OR '),
    trigrams: [...trigrams],
    phrases: [...new Set(phrases)]
  }
}

// ---------------- RRF 融合 ----------------

export interface FusedItem {
  chunkId: string
  /** RRF 融合分 + 重排加权后的最终分（越大越靠前） */
  score: number
  /** 原始 RRF 分（重排前） */
  rrf: number
  inVector: boolean
  inKeyword: boolean
}

/**
 * Reciprocal Rank Fusion（Cormack et al. 2009）：
 *   score(d) = Σ wᵢ / (k + rankᵢ(d))
 *
 * 为什么用 RRF 而不是加权归一化分数：
 * cosine 距离（0~2）和 BM25（无界负值）尺度完全不同，min-max 归一化
 * 在小候选集上极不稳定；RRF 只看"在各路排第几"，对分数分布免疫，
 * 这也是 Elasticsearch/Meilisearch 混合检索的默认融合法。
 * k=60 是论文经验值：越大，头部排名优势越平缓。
 */
export function reciprocalRankFusion(
  vectorIds: string[],
  keywordIds: string[],
  k = 60
): FusedItem[] {
  const items = new Map<string, FusedItem>()

  const accumulate = (ids: string[], channel: 'inVector' | 'inKeyword') => {
    ids.forEach((id, rank) => {
      const existing = items.get(id)
      const add = 1 / (k + rank + 1) // rank 转 1-based：第 1 名 1/61
      if (existing) {
        existing.score += add
        existing.rrf += add
        existing[channel] = true
      } else {
        items.set(id, {
          chunkId: id,
          score: add,
          rrf: add,
          inVector: channel === 'inVector',
          inKeyword: channel === 'inKeyword'
        })
      }
    })
  }

  accumulate(vectorIds, 'inVector')
  accumulate(keywordIds, 'inKeyword')

  return [...items.values()].sort((a, b) => b.score - a.score)
}

// ---------------- 轻量词法重排 ----------------

/**
 * 在 RRF 分上叠加有界词法加分（总计 ≤0.30，不会颠覆 RRF 大盘，
 * 只在伯仲之间偏向"字面更贴查询"的片段）：
 * - 三元组覆盖率（0.15）：查询的字片段有多少真出现在文本里
 * - 精确短语（0.10）：英文词/中文整段连续命中（型号、专名场景强信号）
 * - 标题命中（0.05）：词元出现在 headingPath，结构性相关
 *
 * 这是本地、零额外模型的重排；未来可在此接缝替换为 cross-encoder
 * （如 bge-reranker）精排，retriever 接口不变。
 */
export function lexicalBoost(
  content: string,
  headingPath: string | undefined,
  terms: QueryTerms
): number {
  const text = content.toLowerCase()

  const coverage =
    terms.trigrams.length === 0
      ? 0
      : terms.trigrams.filter((t) => text.includes(t)).length / terms.trigrams.length

  const phraseHit =
    terms.phrases.length === 0
      ? 0
      : terms.phrases.filter((p) => text.includes(p)).length / terms.phrases.length

  const heading = headingPath?.toLowerCase() ?? ''
  const inHeading =
    heading !== '' &&
    (terms.phrases.some((p) => heading.includes(p)) ||
      terms.trigrams.some((t) => heading.includes(t)))

  return 0.15 * coverage + 0.1 * phraseHit + (inHeading ? 0.05 : 0)
}
