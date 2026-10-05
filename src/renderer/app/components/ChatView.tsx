import { useEffect, useRef } from 'react'
import { useConversations } from '../stores/useConversations'
import { useChat } from '../stores/useChat'
import { useSettings } from '../stores/useSettings'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'

/**
 * 主对话区（PRD 5.1）：消息流 + 错误条 + 输入区。
 * 空会话时展示引导（PRD F-A1 空状态）。
 */
export function ChatView() {
  const { currentId, messages } = useConversations()
  const { error, clearError } = useChat()
  const settings = useSettings((s) => s.settings)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 新消息/流式增量都滚动到底部（依赖最后一条内容长度）
  const lastLen = messages.at(-1)?.content.length ?? 0
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, lastLen])

  const visible = messages.filter((m) => m.role !== 'system')

  return (
    <section className="flex h-full flex-1 flex-col bg-paper">
      {/* 顶部模型标识 */}
      <header className="flex items-center justify-between border-b border-line bg-paper px-5 py-2.5">
        <span className="text-xs text-ink2">
          {settings?.provider === 'local' ? '本地模型' : '云端模型'} ·{' '}
          {settings?.model ?? '未配置'}
        </span>
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
              在下方输入即可开始对话。
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
            {visible.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <Composer />
    </section>
  )
}
