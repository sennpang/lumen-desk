import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/ipc'
import { useChat } from '../stores/useChat'
import type {
  AgentStepInfo,
  ChunkInfo,
  MessageRecord
} from '../../../shared/types'

/**
 * 单条消息气泡。
 * - user 右对齐青绿底；assistant 左对齐白纸卡片
 * - streaming：内容为空时显示"正在思考…"，非空时末尾给闪烁光标
 * - error：红色边框提示（F-A1 错误状态可见）
 * - RAG：正文里的 [n] 渲染成可点角标，气泡下挂引用卡片，点击看片段原文
 */

// 模型按 PRD 14.3 prompt 被要求用 [1] [2] 标注来源
const CITATION_MARK_RE = /\[(\d{1,2})\]/g

export function MessageBubble({ message }: { message: MessageRecord }) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm leading-relaxed text-white">
          {message.content}
        </div>
      </div>
    )
  }

  const citations = message.citations ?? []
  const steps = message.agentSteps ?? []
  const showThinking =
    message.status === 'streaming' &&
    !message.content &&
    citations.length === 0 &&
    steps.length === 0

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[85%] rounded-2xl rounded-tl-sm border px-3.5 py-2 text-sm leading-relaxed ${
          message.status === 'error'
            ? 'border-danger bg-danger-bg text-danger'
            : 'border-line bg-card text-ink'
        }`}
      >
        {showThinking ? (
          <span className="text-ink2">
            正在思考<span className="animate-pulse">…</span>
          </span>
        ) : (
          <>
            {steps.length > 0 && <AgentTimeline steps={steps} />}
            {citations.length > 0 && !message.content && (
              <span className="text-xs text-ink2">已检索到 {citations.length} 条资料，生成中…</span>
            )}
            {steps.length > 0 && !message.content && message.status === 'streaming' && (
              <span className="text-xs text-ink2">
                {steps.some((s) => s.confirmStatus === 'waiting')
                  ? '等待你的确认…'
                  : '工具执行中'}
                <span className="animate-pulse">…</span>
              </span>
            )}
            <BodyWithMarks
              content={message.content}
              citationCount={citations.length}
              messageId={message.id}
            />
            {message.status === 'streaming' && (
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand align-middle" />
            )}
          </>
        )}
        {citations.length > 0 && (
          <CitationList messageId={message.id} citations={citations} />
        )}
      </div>
    </div>
  )
}

/** 把正文按 [n] 切开，编号合法（1..引用数）时渲染成可点角标 */
function BodyWithMarks({
  content,
  citationCount,
  messageId
}: {
  content: string
  citationCount: number
  messageId: string
}) {
  const parts = useMemo(() => {
    if (citationCount === 0) return null
    const out: Array<{ kind: 'text' | 'mark'; value: string }> = []
    let last = 0
    let m: RegExpExecArray | null
    CITATION_MARK_RE.lastIndex = 0
    while ((m = CITATION_MARK_RE.exec(content)) !== null) {
      const n = Number(m[1])
      if (m.index > last) out.push({ kind: 'text', value: content.slice(last, m.index) })
      // 越界编号（模型乱标）当普通文本，不做成死链接
      if (n >= 1 && n <= citationCount) {
        out.push({ kind: 'mark', value: m[1] })
      } else {
        out.push({ kind: 'text', value: m[0] })
      }
      last = m.index + m[0].length
    }
    if (last < content.length) out.push({ kind: 'text', value: content.slice(last) })
    return out
  }, [content, citationCount])

  if (!parts) {
    return <span className="whitespace-pre-wrap break-words">{content}</span>
  }

  // 角标点击：滚动到同气泡内对应引用卡片并短暂高亮
  const jumpTo = (n: string) => {
    const el = document.getElementById(`cite-${messageId}-${n}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    if (el) {
      el.classList.add('ring-2', 'ring-brand')
      setTimeout(() => el.classList.remove('ring-2', 'ring-brand'), 1200)
    }
  }

  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.value}</span>
        ) : (
          <button
            key={i}
            onClick={() => jumpTo(p.value)}
            title={`查看引用 ${p.value}`}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-bg px-1 text-[10px] font-medium leading-none text-brand-dark hover:bg-brand hover:text-white"
          >
            {p.value}
          </button>
        )
      )}
    </span>
  )
}

function CitationList({
  messageId,
  citations
}: {
  messageId: string
  citations: NonNullable<MessageRecord['citations']>
}) {
  const [activeId, setActiveId] = useState<string | null>(null)

  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <p className="mb-1 text-[11px] text-ink2">参考来源（{citations.length}）</p>
      <ul className="flex flex-col gap-1.5">
        {citations.map((c, i) => {
          const n = String(i + 1)
          return (
            <li
              key={c.chunkId}
              id={`cite-${messageId}-${n}`}
              className="cursor-pointer rounded-md bg-paper px-2.5 py-1.5 transition hover:bg-brand-bg"
              onClick={() => setActiveId(c.chunkId)}
              title="点击查看片段原文"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-ink2">
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-bg px-1 font-medium text-brand-dark">
                  {n}
                </span>
                <span className="truncate font-medium text-ink">{c.docName}</span>
                {c.page !== null && <span className="shrink-0">第 {c.page} 页</span>}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink2">
                {c.snippet}
              </p>
            </li>
          )
        })}
      </ul>
      {activeId && <ChunkModal chunkId={activeId} onClose={() => setActiveId(null)} />}
    </div>
  )
}

const TOOL_LABELS: Record<string, string> = {
  search_knowledge_base: '检索知识库',
  get_current_datetime: '查询时间',
  open_url: '打开链接',
  save_note: '保存笔记'
}

/** 参数压成一行短文本给人看（完整值在 title/确认卡片里） */
function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  try {
    const text = JSON.stringify(args)
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  } catch {
    return String(args)
  }
}

/**
 * M5 Agent 步骤时间线：thought（思考）/ tool_call（行动）/ observation（观察）
 * 三态节点；副作用工具的等待/批准/拒绝状态与内联确认卡片也挂在这里。
 */
function AgentTimeline({ steps }: { steps: AgentStepInfo[] }) {
  const confirms = useChat((s) => s.confirms)
  const resolveConfirm = useChat((s) => s.resolveConfirm)

  return (
    <div className="mb-2.5 flex flex-col gap-1 border-b border-line pb-2.5">
      {steps.map((step) => {
        if (step.stepType === 'thought') {
          return (
            <details
              key={step.id}
              className="group text-xs text-ink2"
              title="模型在调用工具前的思考"
            >
              <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
                <span>💭</span>
                <span className="text-[11px] text-ink2/70">思考</span>
              </summary>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-paper px-2 py-1.5 italic leading-relaxed">
                {step.result}
              </p>
            </details>
          )
        }

        if (step.stepType === 'tool_call') {
          const label = step.toolName
            ? TOOL_LABELS[step.toolName] ?? step.toolName
            : '工具'
          const card = step.id ? confirms[step.id] : undefined
          return (
            <div key={step.id}>
              <div className="flex items-center gap-1.5 text-xs">
                <span>🔧</span>
                <span className="font-medium text-ink">{label}</span>
                {step.args !== undefined && (
                  <span className="truncate font-mono text-[11px] text-ink2/80">
                    {summarizeArgs(step.args)}
                  </span>
                )}
                {step.confirmStatus === 'waiting' && (
                  <span className="ml-auto shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    待确认
                  </span>
                )}
                {step.confirmStatus === 'approved' && (
                  <span className="ml-auto shrink-0 rounded-full bg-brand-bg px-1.5 py-0.5 text-[10px] font-medium text-brand-dark">
                    已允许
                  </span>
                )}
                {step.confirmStatus === 'denied' && (
                  <span className="ml-auto shrink-0 rounded-full bg-danger-bg px-1.5 py-0.5 text-[10px] font-medium text-danger">
                    已拒绝
                  </span>
                )}
              </div>
              {card && (
                <div className="mt-1.5 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                  <p className="text-xs leading-relaxed text-ink">{card.preview}</p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void resolveConfirm(card.stepId, true)}
                      className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-dark"
                    >
                      允许
                    </button>
                    <button
                      onClick={() => void resolveConfirm(card.stepId, false)}
                      className="rounded-md border border-line px-2.5 py-1 text-xs text-ink2 hover:bg-card"
                    >
                      拒绝
                    </button>
                    <span className="text-[10px] text-ink2/70">
                      该操作有外部副作用，需你确认后才会执行
                    </span>
                  </div>
                </div>
              )}
            </div>
          )
        }

        // observation：默认折两行，title 看全；结果里带 ✅/⚠️ 前缀
        return (
          <div key={step.id} className="flex items-start gap-1.5 pl-6 text-xs text-ink2">
            <span className="mt-px text-ink2/60">↳</span>
            <p className="line-clamp-2 whitespace-pre-wrap break-all leading-relaxed" title={step.result}>
              {step.result}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/** 引用原文弹窗：事件里只带短摘要，点开才按 chunkId 取全文 */
function ChunkModal({ chunkId, onClose }: { chunkId: string; onClose: () => void }) {
  const [chunk, setChunk] = useState<ChunkInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.knowledge
      .getChunk(chunkId)
      .then((c) => {
        if (!cancelled) setChunk(c)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [chunkId])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col rounded-xl border border-line bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="truncate text-sm font-medium text-ink">
            {chunk?.docName ?? '片段原文'}
          </span>
          <button onClick={onClose} className="text-sm text-ink2 hover:text-danger">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3">
          {error ? (
            <p className="text-sm text-danger">读取失败：{error}</p>
          ) : !chunk ? (
            <p className="text-sm text-ink2">加载中…</p>
          ) : (
            <>
              <p className="mb-2 text-xs text-ink2">
                片段 #{chunk.chunkIndex + 1}
                {typeof chunk.meta.page === 'number' && ` · 第 ${chunk.meta.page} 页`}
                {chunk.meta.headingPath && ` · ${chunk.meta.headingPath}`}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {chunk.content}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
