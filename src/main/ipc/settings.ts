import { ipcMain } from 'electron'
import { getSettings, getSettingsView, saveSettings } from '../services/settings/repo'
import { getCloudApiKey, saveCloudApiKey } from '../store/secrets'
import { testConnection } from '../services/llm/client'
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
    const apiKey = getCloudApiKey()
    if (!apiKey) throw new Error('请先填写并保存 API Key')
    await testConnection({
      baseUrl: settings.baseUrl,
      apiKey,
      model: settings.model
    })
    return { ok: true }
  })
}
