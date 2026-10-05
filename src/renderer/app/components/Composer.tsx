import { useEffect, useRef, useState } from 'react'
import { useChat } from '../stores/useChat'
import { useKnowledge } from '../stores/useKnowledge'
import type { ChatMode } from '../../../shared/types'

/**
 * 输入区（PRD 5.1）：
 * - Enter 发送 / Shift+Enter 换行
 * - 生成中按钮切换为"停止"（F-A1 中途停止）
 * - 无会话时也可直接输入（主进程隐式建会话）
 * - 模式三态：普通对话 / 知识库问答（M3 先检索再答）/ 智能体（M5 自主调工具）
 * - rag / agent 都可绑定知识库（agent 的检索工具默认查这个库）
 */
interface ComposerProps {
  mode: ChatMode
  kbId: string | null
  onModeChange: (mode: ChatMode) => void
  onSelectKb: (id: string) => void
}

const MODES: Array<{ key: ChatMode; label: string; hint: string }> = [
  { key: 'chat', label: '对话', hint: '直接与模型聊天' },
  { key: 'rag', label: '知识库问答', hint: '提问前先在知识库检索，回答标注引用来源' },
  { key: 'agent', label: '智能体', hint: '模型自主调用工具：查知识库、看时间、打开链接、保存笔记（副作用操作需你确认）' }
]

export function Composer({ mode, kbId, onModeChange, onSelectKb }: ComposerProps) {
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
    // rag 没有知识库直接拦截；agent 允许无库（时间/链接等工具仍可用）
    if (mode === 'rag' && !kbId) return
    void send(value, mode, kbId ?? undefined)
    setText('')
  }

  const placeholder = running
    ? 'Lumen 正在回复…'
    : mode === 'rag'
      ? '基于知识库提问，回答会标注引用来源 · Enter 发送'
      : mode === 'agent'
        ? '告诉智能体任务，它会自行决定查资料/用工具 · Enter 发送'
        : '输入消息，Enter 发送 / Shift+Enter 换行'

  return (
    <div className="border-t border-line bg-paper px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {/* 模式条：三态分段选择 + 知识库选择 */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-line bg-card p-0.5">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => onModeChange(m.key)}
                title={m.hint}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  mode === m.key
                    ? 'bg-brand font-medium text-white'
                    : 'text-ink2 hover:text-ink'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode !== 'chat' && (
            <select
              value={kbId ?? ''}
              onChange={(e) => onSelectKb(e.target.value)}
              className="rounded-full border border-line bg-card px-2.5 py-1 text-xs text-ink outline-none"
              title={mode === 'agent' ? '智能体检索工具默认使用的知识库' : '要检索的知识库'}
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
            placeholder={placeholder}
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
              disabled={!text.trim() || sending || (mode === 'rag' && !kbId)}
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
