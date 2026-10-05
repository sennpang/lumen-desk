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
