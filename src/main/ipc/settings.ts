import { ipcMain } from 'electron'
import { getSettings, getSettingsView, saveSettings } from '../services/settings/repo'
import { getCloudApiKey, saveCloudApiKey } from '../store/secrets'
import { testConnection } from '../services/llm/client'
import { detectOllama } from '../services/llm/ollama'
import { resolveModelConfig } from '../services/llm/resolve'
import type { SaveSettingsInput } from '../../shared/types'

/**
 * 设置 IPC（F-B1：配置 API Base/Key/模型，Key 安全存储，连接可测试）
 *
 * settings:save 与密钥库的协作：
 * - 非密字段直接写 app_setting；
 * - apiKey 仅在用户确实填了新值时才覆盖 safeStorage 密文，
 *   留空（或省略）表示"沿用已存密钥"——渲染端永远拿不到明文，
 *   也就不可能把一串星号误存成新 Key。
 */
export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => getSettingsView())

  ipcMain.handle('settings:save', (_e, input: SaveSettingsInput) => {
    const { apiKey, ...rest } = input
    if (apiKey && apiKey.trim()) saveCloudApiKey(apiKey)
    saveSettings(rest)
  })

  // 测试"已保存"的配置（避免把未保存的明文 Key 经过 IPC 传来传去）
  ipcMain.handle('settings:test', async () => {
    const settings = getSettings()

    if (settings.provider === 'local') {
      // 本地：先探测服务，再校验模型，再发一次最小请求
      const status = await detectOllama(settings.ollamaUrl)
      if (!status.available) {
        throw new Error(
          `无法连接本地 Ollama 服务（${settings.ollamaUrl}）。请确认已安装并启动 Ollama。${
            status.reason ? `（${status.reason}）` : ''
          }`
        )
      }
      if (!settings.ollamaModel.trim()) {
        throw new Error('Ollama 已连接，但尚未选择模型，请先在模型列表中选择一个。')
      }
    }

    const resolved = resolveModelConfig(settings, getCloudApiKey())
    if (!resolved.ok) throw new Error(resolved.message)
    await testConnection({
      baseUrl: resolved.config.baseUrl,
      apiKey: resolved.config.apiKey,
      model: resolved.config.model
    })
    return { ok: true as const }
  })
}
