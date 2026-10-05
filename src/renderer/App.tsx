import { useEffect, useState } from 'react'
import { Sidebar } from './app/components/Sidebar'
import { ChatView } from './app/components/ChatView'
import { SettingsModal } from './app/components/SettingsModal'
import { api } from './app/lib/ipc'
import { useChat } from './app/stores/useChat'
import { useConversations } from './app/stores/useConversations'
import { useSettings } from './app/stores/useSettings'

/**
 * 应用外壳（PRD 5.1：边栏导航 + 主对话区 + 抽屉式管理页）
 *
 * 这里做三件"全局只做一次"的事：
 * 1. 订阅 chat:event 统一流式事件 -> useChat.handleEvent（返回清理函数）
 * 2. 加载设置（顶栏模型标识依赖它）
 * 3. 加载会话列表
 */
export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const refreshList = useConversations((s) => s.refreshList)

  useEffect(() => {
    const unsubscribe = api.chat.onEvent((ev) => {
      void useChat.getState().handleEvent(ev)
    })
    void useSettings.getState().load()
    void refreshList()
    return unsubscribe
  }, [refreshList])

  return (
    <div className="flex h-full bg-paper text-ink">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <ChatView />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
