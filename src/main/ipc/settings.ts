import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  getSettings,
  getSettingsView,
  sanitizeSettings,
  saveSettings
} from '../services/settings/repo'
import { getCloudApiKey, hasCloudApiKey, saveCloudApiKey } from '../store/secrets'
import { testConnection } from '../services/llm/client'
import { detectOllama } from '../services/llm/ollama'
import { resolveModelConfig } from '../services/llm/resolve'
import type { SaveSettingsInput, SettingsBackup } from '../../shared/types'

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

  // M6 备份：导出非密配置到用户自选 JSON 文件
  ipcMain.handle('settings:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win!, {
      title: '导出 Lumen Desk 设置',
      defaultPath: `lumen-desk-settings-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true as const }
    const backup: SettingsBackup = {
      kind: 'lumen-desk-settings',
      appVersion: app.getVersion(),
      exportedAt: Date.now(),
      settings: getSettings(),
      hasApiKey: hasCloudApiKey()
    }
    writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf8')
    return { canceled: false as const, path: result.filePath }
  })

  // M6 恢复：从 JSON 读回配置（密钥不迁移，仅提示用户重新填写）
  ipcMain.handle('settings:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '导入 Lumen Desk 设置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true as const }
    const parsed: unknown = JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
    // 结构校验：kind 不对就明确报错，防止用户误选其他 JSON
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { kind?: unknown }).kind !== 'lumen-desk-settings'
    ) {
      throw new Error('这不是 Lumen Desk 的设置备份文件（缺少 kind 标识）。')
    }
    const incoming = sanitizeSettings((parsed as SettingsBackup).settings)
    saveSettings(incoming)
    return {
      canceled: false as const,
      hadApiKey: Boolean((parsed as SettingsBackup).hasApiKey),
      // 返回清洗后视图，供渲染端立即刷新表单
      view: getSettingsView()
    }
  })
}
