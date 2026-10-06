import { useEffect, useRef, useState } from 'react'
import { useConversations } from '../stores/useConversations'
import { useChat } from '../stores/useChat'
import { useKnowledge } from '../stores/useKnowledge'
import { useSettings } from '../stores/useSettings'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import type { ChatMode } from '../../../shared/types'

/**
 * 主对话区（PRD 5.1）：消息流 + 错误条 + 输入区。
 * 空会话时展示引导（PRD F-A1 空状态）。
 *
 * 模式跟随会话：切换会话按 conversation.mode 回填（chat/rag/agent）；
 * 新消息写入后该会话以后都以同一模式继续。
 */
export function ChatView() {
  const { list, currentId, messages } = useConversations()
  const { error, clearError } = useChat()
  const settings = useSettings((s) => s.settings)
  const { kbs, currentKbId, init, selectKb } = useKnowledge()
  const bottomRef = useRef<HTMLDivElement>(null)

  const current = list.find((c) => c.id === currentId) ?? null
  const [mode, setMode] = useState<ChatMode>('chat')

  // 知识库列表懒加载（对话区需要下拉选择；init 幂等，会确保默认库）
  useEffect(() => {
    void init()
  }, [init])

  // 切换会话：模式跟随该会话
  useEffect(() => {
    setMode(current?.mode ?? 'chat')
  }, [currentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 新消息/流式增量都滚动到底部（依赖最后一条内容长度或步骤数）
  const lastMsg = messages.at(-1)
  const lastLen =
    (lastMsg?.content.length ?? 0) + (lastMsg?.agentSteps?.length ?? 0)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, lastLen])

  const visible = messages.filter((m) => m.role !== 'system')
  const kbName = kbs.find((k) => k.id === currentKbId)?.name ?? null
  const modeBadge =
    mode === 'rag'
      ? `📚 知识库问答${kbName ? ` · ${kbName}` : ''}`
      : mode === 'agent'
        ? `🤖 智能体${kbName ? ` · ${kbName}` : ''}`
        : null

  return (
    <section className="flex h-full flex-1 flex-col bg-paper">
      {/* 顶部模型标识 */}
      <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-2.5">
        <span className="text-xs text-ink2">
          {settings?.provider === 'local'
            ? `本地模型 · ${settings.ollamaModel || '未选择'}`
            : `云端模型 · ${settings?.model ?? '未配置'}`}
        </span>
        {modeBadge && (
          <span className="rounded-full bg-brand-bg px-2.5 py-0.5 text-xs text-brand-dark">
            {modeBadge}
          </span>
        )}
      </header>

      {error && (
        <div className="flex items-start justify-between gap-3 border-b border-danger bg-danger-bg px-5 py-2 text-sm text-danger">
          <span>出错了：{error}</span>
          <button onClick={clearError} className="shrink-0 underline">
            知道了
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!currentId || visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-lg font-semibold text-ink">Lumen Desk</p>
            <p className="mt-2 max-w-sm text-sm text-ink2">
              一个读过你文档、还能帮你干活的本地 AI 同事。
              <br />
              在下方输入即可开始对话，开启「知识库问答」可基于你导入的文档作答。
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
            {visible.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLast={i === visible.length - 1}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <Composer
        mode={mode}
        kbId={currentKbId}
        onModeChange={setMode}
        onSelectKb={(id) => void selectKb(id)}
      />
    </section>
  )
}
