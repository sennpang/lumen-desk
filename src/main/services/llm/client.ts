import type { ChatMessage, ToolCall } from '../../../shared/types'

/**
 * OpenAI 兼容 Chat Completions 客户端（PRD 第 10 章：手写为主，理解本质）
 *
 * 一套实现同时覆盖：
 * - DeepSeek（默认，https://api.deepseek.com）
 * - OpenAI 及任何 OpenAI 兼容中转网关
 * - Ollama（M2：http://localhost:11434/v1，同一协议）
 *
 * 不引 SDK 的原因：流式就是 HTTP POST + SSE，手写一遍才能讲清楚
 * "逐 token 返回"在传输层到底发生了什么，也避免 SDK 黑盒绑架调试。
 */

/** 发给模型的工具声明（OpenAI tools 协议；M5 Agent 使用） */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema 约束参数（Ollama qwen2.5 / DeepSeek 均按此协议消费） */
    parameters: Record<string, unknown>
  }
}

export interface StreamOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  messages: ChatMessage[]
  signal?: AbortSignal
  /** 不传 = 纯聊天轮；传入后模型可回复 tool_calls（M5） */
  tools?: ToolSchema[]
}

export interface StreamResult {
  content: string
  promptTokens: number
  completionTokens: number
  /** 模型决定调工具时非空（此时 content 可能为空或仅思考文本，M5） */
  toolCalls: ToolCall[]
}

/**
 * ChatMessage（内部 camelCase 协议）→ OpenAI 请求体消息。
 * tool_calls/tool_call_id 只在对应角色上出现，其余消息形态与 M1 一致。
 */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.name) wire.name = m.name
  if (m.toolCallId) wire.tool_call_id = m.toolCallId
  if (m.toolCalls) {
    wire.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments }
    }))
  }
  return wire
}

function endpoint(baseUrl: string): string {
  // 容忍用户填尾部斜杠；兼容只填到 /v1 或不填 /v1 的情况
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1')
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`
}

async function postChat(body: unknown, opts: StreamOptions) {
  const res = await fetch(endpoint(opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    // 尽量读出服务端错误体（DeepSeek/OpenAI 会返回 JSON {error:{message}}）
    const detail = await res.text().catch(() => '')
    throw new Error(`模型接口返回 ${res.status}：${detail.slice(0, 500) || res.statusText}`)
  }
  return res
}

/**
 * 流式对话：async generator，每个 yield 是一段增量文本。
 * 结束时通过 getResult() 取完整文本与用量。
 *
 * 停止生成（F-A1）：外部调用 AbortController.abort() 即可中断 fetch，
 * generator 抛出 AbortError 由上层识别为"用户主动停止"而非错误。
 *
 * M5：opts.tools 非空时，模型可能在任意一轮返回 tool_calls。
 * SSE 里工具调用不是整包下发，而是按 index 分片增量到达
 * （id/name 通常在首片，arguments 是逐字符拼接的 JSON 片段），
 * 必须按下标归并，结束才能解析——这是手写 SSE 最容易踩的坑。
 */
export async function* streamChatCompletion(
  opts: StreamOptions
): AsyncGenerator<string, StreamResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(toWireMessage),
    temperature: opts.temperature,
    stream: true,
    // 让 SSE 最后一帧带 usage（OpenAI/DeepSeek 均支持）
    stream_options: { include_usage: true }
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  const res = await postChat(body, opts)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let promptTokens = 0
  let completionTokens = 0
  // tool_calls 分片归并缓冲：下标稳定，字段逐片补
  const toolParts = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以换行分隔事件；半行留在 buffer 等下一块拼接
      let nlIndex: number
      while ((nlIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIndex).trim()
        buffer = buffer.slice(nlIndex + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          return {
            content,
            promptTokens,
            completionTokens,
            toolCalls: finalizeToolCalls(toolParts)
          }
        }
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens ?? promptTokens
          completionTokens = json.usage.completion_tokens ?? completionTokens
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.tool_calls) {
          for (const frag of delta.tool_calls) {
            const part = toolParts.get(frag.index) ?? {
              id: '',
              name: '',
              arguments: ''
            }
            if (frag.id) part.id = frag.id
            if (frag.function?.name) part.name += frag.function.name
            if (frag.function?.arguments) part.arguments += frag.function.arguments
            toolParts.set(frag.index, part)
          }
        }
        if (delta?.content) {
          content += delta.content
          yield delta.content
        }
      }
    }
  } finally {
    // 无论正常结束、异常还是 abort，都释放底层连接
    reader.releaseLock()
  }

  return {
    content,
    promptTokens,
    completionTokens,
    toolCalls: finalizeToolCalls(toolParts)
  }
}

/** 归并缓冲转 ToolCall[]，并兜底模型漏发 id 的情况（补 call_<n>） */
function finalizeToolCalls(
  parts: Map<number, { id: string; name: string; arguments: string }>
): ToolCall[] {
  return [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, p]) => ({
      id: p.id || `call_${index}`,
      name: p.name,
      arguments: p.arguments
    }))
}

/** 连接测试（F-B1"连接可测试"）：发一次最小请求，成功返回模型回复一句即可 */
export async function testConnection(opts: Omit<StreamOptions, 'messages' | 'temperature'>): Promise<void> {
  await postChat(
    {
      model: opts.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    },
    { ...opts, temperature: 0, messages: [] }
  )
}
