import type { ChatMessage } from '../../../shared/types'

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

export interface StreamOptions {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  messages: ChatMessage[]
  signal?: AbortSignal
}

export interface StreamResult {
  content: string
  promptTokens: number
  completionTokens: number
}

function endpoint(baseUrl: string): string {
  // 容忍用户填尾部斜杠；兼容只填到 /v1 或不填 /v1 的情况
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1')
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`
}

async function postChat(body: unknown, opts: StreamOptions, stream: boolean) {
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
 */
export async function* streamChatCompletion(
  opts: StreamOptions
): AsyncGenerator<string, StreamResult> {
  const res = await postChat(
    {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      stream: true,
      // 让 SSE 最后一帧带 usage（OpenAI/DeepSeek 均支持）
      stream_options: { include_usage: true }
    },
    opts,
    true
  )

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let promptTokens = 0
  let completionTokens = 0

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
          return { content, promptTokens, completionTokens }
        }
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens ?? promptTokens
          completionTokens = json.usage.completion_tokens ?? completionTokens
        }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          content += delta
          yield delta
        }
      }
    }
  } finally {
    // 无论正常结束、异常还是 abort，都释放底层连接
    reader.releaseLock()
  }

  return { content, promptTokens, completionTokens }
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
    { ...opts, temperature: 0, messages: [] },
    false
  )
}
