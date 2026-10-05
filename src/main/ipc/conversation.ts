import { ipcMain } from 'electron'
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation
} from '../../services/conversations/repo'
import { listMessages } from '../../services/conversations/repo'
import type { ChatMode } from '../../../shared/types'

/**
 * 会话管理 IPC（F-A3：新建/重命名/删除/切换，列表按更新时间排序）
 *
 * 频道：conv:create / conv:list / conv:get / conv:rename / conv:remove
 * conv:get 返回会话元信息 + 消息列表（切换会话时一次拿全，渲染端回填）。
 */
export function registerConversationHandlers(): void {
  ipcMain.handle('conv:create', (_e, mode: ChatMode = 'chat') => createConversation(mode, null))

  ipcMain.handle('conv:list', () => listConversations())

  ipcMain.handle('conv:get', (_e, id: string) => {
    const conv = getConversation(id)
    if (!conv) throw new Error('会话不存在或已被删除')
    return { conversation: conv, messages: listMessages(id) }
  })

  ipcMain.handle('conv:rename', (_e, id: string, title: string) => {
    if (!title?.trim()) throw new Error('会话标题不能为空')
    renameConversation(id, title)
  })

  ipcMain.handle('conv:remove', (_e, id: string) => {
    deleteConversation(id)
  })
}
