import { estimateTokens } from '../llm/context'
import type { ChunkMeta } from '../../../shared/types'
import type { ParsedBlock, ParsedDoc } from './types'

/**
 * 切分器（PRD 14.1：目标约 500 token、相邻片段约 50 token 重叠）
 *
 * 两阶段结构保留切分：
 * 1. 遍历 ParsedBlock：维护 Markdown 标题栈，把段落展开成带 meta 的语义单元
 *    （单元 = 一个段落，携带 page 与当前标题面包屑）
 * 2. 贪心打包：短段落不断并入当前块直到接近预算；装不下就封口；
 *    单个段落就超长时，滑动窗口二次切分（重叠只在这里发生——段落是
 *    天然语义边界，跨块重复整段弊大于利）
 * 3. 尾巴合并：最后一个块过小时并进上一块，避免孤儿碎片
 */

export interface ChunkingOptions {
  targetTokens?: number
  overlapTokens?: number
}

export interface RawChunk {
  content: string
  tokenCount: number
  meta: ChunkMeta
}

const DEFAULT_TARGET = 500
const DEFAULT_OVERLAP = 50

interface Unit {
  text: string
  page: number | null
  headingPath: string
}

export function chunkDocument(
  doc: ParsedDoc,
  opts: ChunkingOptions = {}
): RawChunk[] {
  const target = opts.targetTokens ?? DEFAULT_TARGET
  const overlap = opts.overlapTokens ?? DEFAULT_OVERLAP

  // -------- 阶段 1：块 → 语义单元（带标题面包屑与页码） --------
  const units = toUnits(doc.blocks)

  // -------- 阶段 2：贪心打包 + 超长窗口切分 --------
  const chunks: RawChunk[] = []
  let current: Unit[] = []
  let currentTokens = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push(buildChunk(current))
    current = []
    currentTokens = 0
  }

  for (const unit of units) {
    const tokens = estimateTokens(unit.text)

    if (tokens > target) {
      // 单段落超长：先封口已积累内容，再对该段落滑动窗口切分
      flush()
      for (const windowText of splitLongUnit(unit.text, target, overlap)) {
        chunks.push({
          content: windowText,
          tokenCount: estimateTokens(windowText),
          meta: metaOf(unit)
        })
      }
      continue
    }

    // 标题边界强制封口：即使没超预算，也不把不同小节的段落混进一个 chunk——
    // 否则 headingPath 只能保留首段的标题，引用与检索都会丢失小节归属
    if (current.length > 0 && current[0].headingPath !== unit.headingPath) {
      flush()
    }

    // 加入该单元会超预算且当前块非空 → 封口另起
    if (current.length > 0 && currentTokens + tokens > target) {
      flush()
    }
    current.push(unit)
    currentTokens += tokens
  }
  flush()

  mergeTinyTail(chunks, target)
  return chunks
}

// ---------------- 阶段 1：标题栈 ----------------

function toUnits(blocks: ParsedBlock[]): Unit[] {
  const headingStack: Array<{ level: number; text: string }> = []
  const units: Unit[] = []

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // 弹出栈中级别 >= 当前的标题：同级是替换，更深层级是离开该小节
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= block.level
      ) {
        headingStack.pop()
      }
      headingStack.push({ level: block.level, text: block.text })
    } else {
      units.push({
        text: block.text,
        page: block.page,
        headingPath: headingStack.map((h) => h.text).join(' / ')
      })
    }
  }
  return units
}

// ---------------- 阶段 2：窗口切分 ----------------

const SENTENCE_BREAK_RE = /[。！？!?；;\n…]/

/**
 * 长段落滑动窗口：
 * - 窗口按 token 预算扩张（estimateTokens 是近似线性，直接按字符扫描）
 * - 下一个窗口回退约 overlap token；优先落在句读点，避免把一句话腰斩
 * - 回退必须真正前进（nextStart > start），极端超长无标点文本也不会死循环
 */
function splitLongUnit(
  text: string,
  target: number,
  overlap: number
): string[] {
  const windows: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + 1
    while (
      end < text.length &&
      estimateTokens(text.slice(start, end + 1)) <= target
    ) {
      end++
    }

    windows.push(text.slice(start, end).trim())

    if (end >= text.length) break

    const nextStart = end - backoffChars(text, start, end, overlap)
    // 防御：回退不能卡住窗口，也不能回退超过当前窗口起点
    start = Math.max(nextStart, start + 1)
  }

  return windows.filter((w) => w.length > 0)
}

/**
 * 计算从 end 向前回退多少字符：在候选区间内找最后一个句读位置，
 * 找不到则按 overlap token 硬回退。
 */
function backoffChars(
  text: string,
  start: number,
  end: number,
  overlap: number
): number {
  // 候选区间按字符放宽：中文约 1 字/token，英文约 4 字符/token，
  // overlap*4 覆盖英文极端情况；同时不超出当前窗口
  const lookbackLimit = Math.min(end - start, overlap * 4)
  const candidate = text.slice(end - lookbackLimit, end)

  let best = -1
  for (let i = 0; i < candidate.length; i++) {
    if (SENTENCE_BREAK_RE.test(candidate[i])) best = i
  }
  if (best >= 0) {
    // 从句读符"之后"开始重叠：句号留在上一窗口末尾，新窗口不从标点起头
    const dist = candidate.length - (best + 1)
    if (estimateTokens(candidate.slice(best + 1)) <= overlap * 2 && dist > 0) {
      return dist
    }
  }

  // 硬回退：从 end 向前收，直到尾部 token 数接近 overlap
  let dist = 0
  while (dist < end - start) {
    dist++
    if (estimateTokens(text.slice(end - dist, end)) >= overlap) break
  }
  return Math.max(1, dist)
}

// ---------------- 组装与收尾 ----------------

function buildChunk(units: Unit[]): RawChunk {
  // page 取块内第一个单元的起始页（段落不跨页；同块通常也在同页）
  const first = units[0]
  return {
    content: units.map((u) => u.text).join('\n\n'),
    tokenCount: estimateTokens(units.map((u) => u.text).join('\n\n')),
    meta: metaOf(first)
  }
}

function metaOf(unit: Unit): ChunkMeta {
  const meta: ChunkMeta = { page: unit.page }
  if (unit.headingPath) meta.headingPath = unit.headingPath
  return meta
}

/**
 * 末块过小时并入上一块（阈值：目标预算的 15%）。
 * 合并后可能略超 target——检索质量上"完整小段"优于"孤儿碎片"。
 */
function mergeTinyTail(chunks: RawChunk[], target: number): void {
  if (chunks.length < 2) return
  const tail = chunks[chunks.length - 1]
  const prev = chunks[chunks.length - 2]
  // 同标题约束：宁可保留小尾块，也不把两个小节粘在一起
  const sameSection = tail.meta.headingPath === prev.meta.headingPath
  if (sameSection && tail.tokenCount <= Math.round(target * 0.15)) {
    prev.content = `${prev.content}\n\n${tail.content}`
    prev.tokenCount = estimateTokens(prev.content)
    chunks.pop()
  }
}
