import { useEffect, useState } from 'react'
import { api } from '../lib/ipc'
import { useConversations } from '../stores/useConversations'
import { useUpdater } from '../stores/useUpdater'
import type { MessageSearchHit } from '../../../shared/types'

interface SidebarProps {
  view: 'chat' | 'knowledge'
  onNavigate: (view: 'chat' | 'knowledge') => void
  onOpenSettings: () => void
}

/**
 * 左侧边栏（PRD 5.1）：新建对话、历史搜索、会话列表、知识库入口、设置入口。
 * 会话项支持：单击切换、双击/按钮重命名（行内编辑）、删除（confirm 二次确认）。
 */
export function Sidebar({ view, onNavigate, onOpenSettings }: SidebarProps) {
  const { list, currentId, createNew, select, rename, remove } = useConversations()
  // 订阅更新状态的派生标志（state 变化时重渲染）
  const updateStatus = useUpdater((s) => s.state?.status)
  const hasUpdate =
    updateStatus === 'available' ||
    updateStatus === 'downloading' ||
    updateStatus === 'downloaded'
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // 历史消息搜索：输入防抖 200ms，空串不发请求
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const trimmedQuery = query.trim()

  useEffect(() => {
    if (!trimmedQuery) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(() => {
      api.conversation
        .search(trimmedQuery)
        .then((r) => {
          if (!cancelled) setHits(r)
        })
        .catch(() => {
          if (!cancelled) setHits([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmedQuery])

  const openHit = async (hit: MessageSearchHit) => {
    await select(hit.conversationId)
    setQuery('')
  }

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setDraft(title)
  }

  const commitRename = async () => {
    if (editingId && draft.trim()) {
      await rename(editingId, draft.trim())
    }
    setEditingId(null)
  }

  const handleRemove = async (id: string, title: string) => {
    // window.confirm 在 Electron 中可用（window.prompt 不可用，所以重命名用行内编辑）
    if (window.confirm(`确定删除会话「${title}」吗？该会话的全部消息将被删除。`)) {
      await remove(id)
    }
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-card">
      <div className="p-3">
        <button
          onClick={() => void createNew('chat')}
          className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-dark"
        >
          ＋ 新建对话
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索历史消息…"
          className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm outline-none placeholder:text-ink2/60 focus:border-brand"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {trimmedQuery ? (
          // ---- 搜索结果态 ----
          searching && hits.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-ink2">搜索中…</p>
          ) : hits.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-ink2">
              没有包含「{trimmedQuery}」的消息
            </p>
          ) : (
            <ul className="space-y-0.5">
              {hits.map((h) => (
                <li key={h.messageId}>
                  <button
                    onClick={() => void openHit(h)}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper"
                    title="打开所在会话"
                  >
                    <span className="flex items-center gap-1.5 text-xs text-ink2">
                      <span className="shrink-0">{h.role === 'user' ? '🧑 我' : '🤖 AI'}</span>
                      <span className="truncate">{h.conversationTitle}</span>
                    </span>
                    <span className="line-clamp-2 text-xs leading-relaxed text-ink">
                      {h.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : list.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-ink2">
            还没有对话
            <br />
            点击上方按钮开始
          </p>
        ) : (
          // ---- 会话列表态 ----
          <ul className="space-y-0.5">
            {list.map((c) => (
              <li key={c.id}>
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="w-full rounded-md border border-brand px-2 py-1.5 text-sm outline-none"
                  />
                ) : (
                  <div
                    onClick={() => void select(c.id)}
                    onDoubleClick={() => startRename(c.id, c.title)}
                    className={`group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
                      c.id === currentId
                        ? 'bg-brand-bg font-medium text-brand-dark'
                        : 'text-ink hover:bg-paper'
                    }`}
                    title="单击切换，双击重命名"
                  >
                    <span className="flex-1 truncate">{c.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(c.id, c.title)
                      }}
                      className="opacity-0 transition group-hover:opacity-100"
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleRemove(c.id, c.title)
                      }}
                      className="opacity-0 transition hover:text-danger group-hover:opacity-100"
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-line p-2">
        <button
          onClick={() => onNavigate('knowledge')}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            view === 'knowledge'
              ? 'bg-brand-bg font-medium text-brand-dark'
              : 'text-ink2 hover:bg-paper'
          }`}
        >
          📚 知识库
        </button>
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink2 hover:bg-paper"
        >
          ⚙️ 设置
          {/* 后台静默检查发现/下载中/已下载新版本时给个琥珀红点 */}
          {hasUpdate && (
            <span
              className="ml-auto inline-block h-2 w-2 rounded-full bg-amber-500"
              title="有新版本可用"
            />
          )}
        </button>
      </div>
    </aside>
  )
}
