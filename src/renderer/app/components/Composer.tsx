import { useEffect, useRef, useState } from 'react'
import { useChat } from '../stores/useChat'
import { useKnowledge } from '../stores/useKnowledge'

/**
 * 输入区（PRD 5.1）：
 * - Enter 发送 / Shift+Enter 换行
 * - 生成中按钮切换为"停止"（F-A1 中途停止）
 * - 无会话时也可直接输入（主进程隐式建会话）
 * - M3：知识库问答开关 + 知识库选择（mode='rag' 时先检索再回答）
 */
interface ComposerProps {
  ragEnabled: boolean
  kbId: string | null
  onToggleRag: (on: boolean) => void
  onSelectKb: (id: string) => void
}

export function Composer({
  ragEnabled,
  kbId,
  onToggleRag,
  onSelectKb
}: ComposerProps) {
  const [text, setText] = useState('')
  const { send, stop, activeRun, sending } = useChat()
  const kbs = useKnowledge((s) => s.kbs)
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
    if (ragEnabled && !kbId) return
    void send(value, ragEnabled ? 'rag' : 'chat', kbId ?? undefined)
    setText('')
  }

  return (
    <div className="border-t border-line bg-paper px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {/* 模式条：RAG 开关 + 知识库选择 */}
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => onToggleRag(!ragEnabled)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
              ragEnabled
                ? 'border-brand bg-brand-bg font-medium text-brand-dark'
                : 'border-line text-ink2 hover:bg-card'
            }`}
            title="开启后，每次提问先在知识库检索相关片段，再带着资料回答"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                ragEnabled ? 'bg-brand' : 'bg-ink2/40'
              }`}
            />
            知识库问答
          </button>
          {ragEnabled && (
            <select
              value={kbId ?? ''}
              onChange={(e) => onSelectKb(e.target.value)}
              className="rounded-full border border-line bg-card px-2.5 py-1 text-xs text-ink outline-none"
            >
              {kbs.length === 0 && <option value="">无可用知识库</option>}
              {kbs.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-end gap-2">
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
            placeholder={
              running
                ? 'Lumen 正在回复…'
                : ragEnabled
                  ? '基于知识库提问，回答会标注引用来源 · Enter 发送'
                  : '输入消息，Enter 发送 / Shift+Enter 换行'
            }
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
              disabled={!text.trim() || sending || (ragEnabled && !kbId)}
              className="shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
