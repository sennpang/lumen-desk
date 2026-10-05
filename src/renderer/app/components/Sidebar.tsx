import { useState } from 'react'
import { useConversations } from '../stores/useConversations'

interface SidebarProps {
  onOpenSettings: () => void
}

/**
 * 左侧边栏（PRD 5.1）：新建对话、会话列表、知识库入口、设置入口。
 * 会话项支持：单击切换、双击/按钮重命名（行内编辑）、删除（confirm 二次确认）。
 */
export function Sidebar({ onOpenSettings }: SidebarProps) {
  const { list, currentId, createNew, select, rename, remove } = useConversations()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

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

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {list.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-ink2">
            还没有对话
            <br />
            点击上方按钮开始
          </p>
        )}
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
      </nav>

      <div className="border-t border-line p-2">
        <button
          disabled
          className="flex w-full cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink2 opacity-50"
          title="M3 里程碑上线"
        >
          📚 知识库（M3）
        </button>
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink2 hover:bg-paper"
        >
          ⚙️ 设置
        </button>
      </div>
    </aside>
  )
}
