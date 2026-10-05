import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/ipc'
import type { ChunkInfo, MessageRecord } from '../../../shared/types'

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
  const showThinking =
    message.status === 'streaming' && !message.content && citations.length === 0

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
            {citations.length > 0 && !message.content && (
              <span className="text-xs text-ink2">已检索到 {citations.length} 条资料，生成中…</span>
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
