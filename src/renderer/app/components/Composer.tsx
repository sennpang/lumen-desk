import { useEffect, useRef, useState } from 'react'
import { useChat } from '../stores/useChat'

/**
 * 输入区（PRD 5.1）：
 * - Enter 发送 / Shift+Enter 换行
 * - 生成中按钮切换为"停止"（F-A1 中途停止）
 * - 无会话时也可直接输入（主进程隐式建会话）
 */
export function Composer() {
  const [text, setText] = useState('')
  const { send, stop, activeRun, sending } = useChat()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const running = activeRun !== null || sending

  // 自适应高度：内容增高时撑开，最高 160px 后内部滚动
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const submit = () => {
    const value = text.trim()
    if (!value || running) return
    void send(value)
    setText('')
  }

  return (
    <div className="border-t border-line bg-paper px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={running ? 'Lumen 正在回复…' : '输入消息，Enter 发送 / Shift+Enter 换行'}
          disabled={activeRun !== null}
          className="max-h-40 flex-1 resize-none rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand disabled:bg-paper"
        />
        {running ? (
          <button
            onClick={() => void stop()}
            className="shrink-0 rounded-xl border border-danger px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger-bg"
          >
            停止
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || sending}
            className="shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
