import type { MessageRecord } from '../../../shared/types'

/**
 * 单条消息气泡。
 * - user 右对齐青绿底；assistant 左对齐白纸卡片
 * - streaming：内容为空时显示"正在思考…"，非空时末尾给闪烁光标
 * - error：红色边框提示（F-A1 错误状态可见）
 */
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

  const showThinking = message.status === 'streaming' && !message.content

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm border px-3.5 py-2 text-sm leading-relaxed ${
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
            {message.content}
            {message.status === 'streaming' && (
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand align-middle" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
