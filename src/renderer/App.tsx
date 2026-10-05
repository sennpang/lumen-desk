import { useEffect, useState } from 'react'
import { Sidebar } from './app/components/Sidebar'
import { ChatView } from './app/components/ChatView'
import { KnowledgeView } from './app/components/KnowledgeView'
import { SettingsModal } from './app/components/SettingsModal'
import { api } from './app/lib/ipc'
import { useChat } from './app/stores/useChat'
import { useConversations } from './app/stores/useConversations'
import { useKnowledge } from './app/stores/useKnowledge'
import { useSettings } from './app/stores/useSettings'

type AppView = 'chat' | 'knowledge'

/**
 * 应用外壳（PRD 5.1：边栏导航 + 主对话区 + 抽屉式管理页）
 *
 * 这里做三件"全局只做一次"的事：
 * 1. 订阅 chat:event 统一流式事件 -> useChat.handleEvent（返回清理函数）
 * 2. 订阅 kb:event 导入生命周期 -> useKnowledge.handleKbEvent
 * 3. 加载设置（顶栏模型标识依赖它）与会话列表
 */
export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<AppView>('chat')
  const refreshList = useConversations((s) => s.refreshList)

  useEffect(() => {
    const offChat = api.chat.onEvent((ev) => {
      void useChat.getState().handleEvent(ev)
    })
    const offKb = api.knowledge.onKbEvent((ev) => {
      void useKnowledge.getState().handleKbEvent(ev)
    })
    void useSettings.getState().load()
    void refreshList()
    return () => {
      offChat()
      offKb()
    }
  }, [refreshList])

  return (
    <div className="flex h-full bg-paper text-ink">
      <Sidebar
        view={view}
        onNavigate={setView}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {view === 'chat' ? (
        <ChatView />
      ) : (
        <KnowledgeView onBack={() => setView('chat')} />
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
