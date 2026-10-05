import type { AppSettings, ChatMessage } from '../../../shared/types'
import { streamChatCompletion } from './client'

/**
 * 多轮上下文管理（F-A2）：token 估算 + 超限压缩
 *
 * 为什么需要：模型上下文窗口有上限，长对话把全部历史塞进去会：
 * 1. 触发接口 400（context length exceeded）；
 * 2. 即使不报错，也持续浪费 token、抬高成本与延迟。
 * 策略（PRD 15.4）：超阈值时，用一次 LLM 调用把早期对话压成摘要，
 * 用一条 system 摘要消息替换它们，最近若干轮原文保留（近期信息最关键）。
 */

/**
 * 粗略 token 估算（无本地 tokenizer 依赖）：
 * - 中日韩字符：约 1 字 1 token（主流 BPE 对 CJK 基本如此）
 * - 其他字符：约 4 字符 1 token（英文经验值）
 * 不精确但单调、零成本、跨模型通用；用途只是"决定何时压缩"，不需要精确。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    if (isCjk) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

export function messagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(m.content) + 4 // +4 角色/结构开销
  return total
}

/** 触发阈值取配置窗口的 80%，留 20% 给本轮输入与回复 */
function threshold(settings: AppSettings): number {
  return Math.floor(settings.maxContextTokens * 0.8)
}

/** 压缩时保留最近的对话条数（按消息计，约几轮） */
const KEEP_RECENT = 8

export interface CompactDeps {
  baseUrl: string
  apiKey: string
}

/**
 * 若超限则就地压缩历史。
 * 返回压缩后（或无需压缩时原样）的消息数组。
 */
export async function compactIfNeeded(
  messages: ChatMessage[],
  settings: AppSettings,
  deps: CompactDeps
): Promise<ChatMessage[]> {
  if (messagesTokens(messages) <= threshold(settings)) return messages

  const head = messages.slice(0, -KEEP_RECENT)
  const tail = messages.slice(-KEEP_RECENT)
  if (head.length === 0) return messages // 全是近期消息也超：只能交给模型窗口硬扛

  const transcript = head
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 12000) // 摘要请求本身也要防止超长

  const summarizer: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是对话摘要器。请把下面的多轮历史压缩为一段简洁的中文摘要，' +
        '保留：用户的关键诉求、已确认的事实与决定、未解决的问题。不要丢失数字与专有名词。'
    },
    { role: 'user', content: `需要摘要的对话：\n${transcript}` }
  ]

  let summary = ''
  const stream = streamChatCompletion({
    ...deps,
    // 摘要固定走主模型；复用流式接口但这里消费成完整字符串
    model: settings.model,
    temperature: 0.2,
    messages: summarizer
  })
  for await (const delta of stream) summary += delta

  return [
    { role: 'system', content: `【早期对话摘要】\n${summary}` },
    ...tail
  ]
}
