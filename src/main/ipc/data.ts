import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildDataBackup, restoreDataBackup } from '../services/backup'
import type { DataBackup } from '../../shared/types'

/**
 * 全量数据备份 IPC（data:export / data:import）。
 * 与 settings:export/import 同构：系统保存/打开对话框选 JSON 文件。
 * 密钥与向量索引都不在备份范围内（见 services/backup.ts 顶部说明）。
 */
export function registerDataHandlers(): void {
  ipcMain.handle('data:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win!, {
      title: '导出 Lumen Desk 全部数据',
      defaultPath: `lumen-desk-data-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true as const }
    const backup = buildDataBackup(app.getVersion())
    writeFileSync(result.filePath, JSON.stringify(backup), 'utf8')
    return {
      canceled: false as const,
      path: result.filePath,
      conversations: backup.conversations.length,
      knowledgeBases: backup.knowledgeBases.length
    }
  })

  ipcMain.handle('data:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '导入 Lumen Desk 数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const }
    }
    const parsed: unknown = JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
    // 结构校验/清洗在 restoreDataBackup 内完成，失败直接抛给渲染端横幅
    const summary = restoreDataBackup(parsed as DataBackup)
    return { canceled: false as const, summary }
  })
}
