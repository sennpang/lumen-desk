import { ipcMain } from 'electron'
import { detectOllama, listOllamaModels } from '../services/llm/ollama'
import { getSettings } from '../services/settings/repo'
import type { OllamaModelInfo, OllamaStatus } from '../../shared/types'

/**
 * Ollama IPC（F-B2 自动发现）
 *
 * - ollama:status  探测服务是否在跑（短超时、不抛错），返回版本与原因
 * - ollama:models  列出已安装模型（用户主动刷新，失败抛错回 UI）
 *
 * 地址一律取"已保存"设置里的 ollamaUrl：和 settings:test 一样，
 * 不接收渲染端传来的 URL，避免设置页输入框里"未保存的值"造成行为不一致。
 */
export function registerOllamaHandlers(): void {
  ipcMain.handle('ollama:status', async (): Promise<OllamaStatus> => {
    const { ollamaUrl } = getSettings()
    return detectOllama(ollamaUrl)
  })

  ipcMain.handle('ollama:models', async (): Promise<OllamaModelInfo[]> => {
    const { ollamaUrl } = getSettings()
    return listOllamaModels(ollamaUrl)
  })
}
