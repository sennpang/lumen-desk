import type { OllamaModelInfo, OllamaStatus } from '../../../shared/types'

/**
 * Ollama 本地模型发现（F-B2：自动发现本地服务、列出已安装模型）
 *
 * Ollama 以本机 HTTP 服务形式运行（默认 127.0.0.1:11434），提供两类接口：
 * - 原生管理接口：/api/version（版本）、/api/tags（已安装模型列表）
 * - OpenAI 兼容接口：/v1/chat/completions（对话复用现有 LLM 客户端）
 *
 * 关键点：这些请求全部由主进程发出，目标是回环地址 127.0.0.1，
 * 不经过任何外部网络——这是"断网可用、数据不外发"（PRD 第 6 章）的根本保证。
 */

/** 发现探测超时：服务不存在时要快速失败，不能让 UI 长时间等待 */
const DISCOVER_TIMEOUT_MS = 1500
/** 拉模型列表稍宽裕些（ollama 偶尔需要从本地库读取元数据） */
const TAGS_TIMEOUT_MS = 4000

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`Ollama 返回 ${res.status}`)
  return res.json()
}

/**
 * 探测 Ollama 服务。永不抛异常——探测类调用约定为"返回状态"，
 * 让渲染端用一份数据渲染三种 UI（已连接/未安装/出错）。
 */
export async function detectOllama(baseUrl: string): Promise<OllamaStatus> {
  try {
    const json = (await getJson(joinUrl(baseUrl, '/api/version'), DISCOVER_TIMEOUT_MS)) as {
      version?: string
    }
    return { available: true, version: json.version ?? null, reason: null }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { available: false, version: null, reason }
  }
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    size?: number
    details?: {
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

/**
 * 列出已安装（ollama pull 过）的模型。
 * 与 detect 不同，这里失败要抛错——只有用户明确点"刷新列表"才会调用，
 * 抛错由 IPC 转成 Promise rejection，UI 直接展示原因。
 */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelInfo[]> {
  const json = (await getJson(
    joinUrl(baseUrl, '/api/tags'),
    TAGS_TIMEOUT_MS
  )) as OllamaTagsResponse
  const models = json.models ?? []
  return models
    .filter((m) => Boolean(m.name))
    .map((m) => ({
      name: m.name as string,
      parameterSize: m.details?.parameter_size ?? '',
      quantization: m.details?.quantization_level ?? '',
      size: m.size ?? 0
    }))
}
