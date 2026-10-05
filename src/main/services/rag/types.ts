/**
 * 文档解析层的中间表示（PRD 14.1：解析 → 切分两步解耦）
 *
 * parser 只负责把四种格式归一成"有序块序列"，不关心 token、不关心长度：
 * - heading：仅 Markdown 能可靠识别，chunker 用它维护标题面包屑
 * - paragraph：普通文本块，PDF 块带页码，其他格式 page=null
 *
 * 为什么中间表示不直接给 chunk：
 * 切分策略（目标长度/重叠/标题边界）会反复调优，独立于格式解析；
 * 且不同格式共享同一个 chunker，格式差异全部在 parser 消化掉。
 */
export type DocFormat = 'pdf' | 'docx' | 'md' | 'txt'

export type ParsedBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string; page: number | null }

export interface ParsedDoc {
  format: DocFormat
  blocks: ParsedBlock[]
}
