import type { AppSettings } from '../../../shared/types'

/**
 * 模型配置解析（F-B1 云端 / F-B2 本地 的统一出口）
 *
 * 无论云端还是本地，最终都归一化为同一个 OpenAI 兼容请求配置，
 * LLM 客户端（client.ts）因此完全不需要知道 provider 的存在。
 */

export interface ResolvedModelConfig {
  baseUrl: string
  /** 本地模式下为占位串：Ollama 不校验 Authorization，但协议要求该头存在 */
  apiKey: string
  model: string
}

export type ResolveResult =
  | { ok: true; config: ResolvedModelConfig }
  | { ok: false; message: string }

export function resolveModelConfig(
  settings: AppSettings,
  cloudApiKey: string | null
): ResolveResult {
  if (settings.provider === 'local') {
    if (!settings.ollamaModel.trim()) {
      return {
        ok: false,
        message: '尚未选择本地模型，请在「设置」中检测 Ollama 并选择一个已安装模型。'
      }
    }
    return {
      ok: true,
      config: {
        // client 会自动补 /v1/chat/completions
        baseUrl: settings.ollamaUrl,
        apiKey: 'ollama',
        model: settings.ollamaModel.trim()
      }
    }
  }

  if (!cloudApiKey) {
    return { ok: false, message: '尚未配置 API Key，请先在「设置」中填写并保存。' }
  }
  if (!settings.model.trim()) {
    return { ok: false, message: '尚未填写云端模型名，请在「设置」中配置。' }
  }
  return {
    ok: true,
    config: {
      baseUrl: settings.baseUrl,
      apiKey: cloudApiKey,
      model: settings.model.trim()
    }
  }
}

/**
 * embedding 服务配置解析（M3）。
 *
 * 与对话模型刻意解耦：embeddingProvider 独立选择。
 * - ollama：走 {ollamaUrl}/v1/embeddings（OpenAI 兼容形态）
 * - cloud：复用对话网关地址与 Key，但模型名单独配置——
 *   DeepSeek 本身不提供 embedding 接口，用户需改用同时提供
 *   /v1/embeddings 的网关（硅基流动/智谱/OpenAI 等）
 */
export function resolveEmbeddingConfig(
  settings: AppSettings,
  cloudApiKey: string | null
): ResolveResult {
  if (settings.embeddingProvider === 'ollama') {
    if (!settings.ollamaEmbedModel.trim()) {
      return {
        ok: false,
        message: '尚未填写本地 embedding 模型（如 nomic-embed-text），请在「设置」中配置。'
      }
    }
    return {
      ok: true,
      config: {
        baseUrl: settings.ollamaUrl,
        apiKey: 'ollama',
        model: settings.ollamaEmbedModel.trim()
      }
    }
  }

  if (!cloudApiKey) {
    return { ok: false, message: '云端向量化需要 API Key，请先在「设置」中填写并保存。' }
  }
  if (!settings.cloudEmbedModel.trim()) {
    return {
      ok: false,
      message:
        '尚未填写云端 embedding 模型名（如 text-embedding-3-small、bge-large-zh-v1.5），请在「设置」中配置。'
    }
  }
  return {
    ok: true,
    config: {
      baseUrl: settings.baseUrl,
      apiKey: cloudApiKey,
      model: settings.cloudEmbedModel.trim()
    }
  }
}
