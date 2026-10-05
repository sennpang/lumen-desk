import { app, ipcMain } from 'electron'
import { registerConversationHandlers } from './conversation'
import { registerChatHandlers } from './chat'
import { registerSettingsHandlers } from './settings'
import { registerOllamaHandlers } from './ollama'
import { registerKbHandlers } from './knowledge'
import { registerDialogHandlers } from './dialog'

/**
 * IPC 处理器注册中心（PRD 第 13 章：IPC 接口规范）
 *
 * 设计约定：
 * - 频道命名采用 "命名空间:动作"，如 chat:run / conv:list / kb:import
 * - 渲染进程只能用 ipcRenderer.invoke（请求-响应）+ webContents.send（流式推送），
 *   禁止 render -> main 的 send 类单向火并，保证每个调用都有明确的结果/错误回执
 * - 本文件只做"注册"，每个命名空间的实现放在同名模块里（chat.ts / knowledge.ts ...）
 */

export function registerIpcHandlers(): void {
  // 各命名空间处理器
  registerConversationHandlers()
  registerChatHandlers()
  registerSettingsHandlers()
  registerOllamaHandlers()
  registerKbHandlers()
  registerDialogHandlers()

  // M0 健康检查：验证渲染进程 -> 主进程的 invoke 链路已打通
  ipcMain.handle('app:ping', () => {
    return {
      pong: true,
      version: app.getVersion(),
      platform: process.platform,
      time: Date.now()
    }
  })
}
