import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../lib/ipc'
import { useKnowledge } from '../stores/useKnowledge'
import { useSettings } from '../stores/useSettings'
import type { ChunkInfo, DocumentInfo } from '../../../shared/types'

/**
 * 知识库管理页（PRD 5.1 抽屉式管理页 / F-C1 F-C2）。
 *
 * 与 ChatView 同级的主区域，由侧边栏「📚 知识库」切入：
 * - 导入：系统文件选择框 + 拖拽（webUtils 路径）
 * - 文档卡片三态：parsing（解析中）/ ready（可展开看切分片段）/ failed（原因）
 * - 删除、换 embedding 模型后的重建索引
 */

const ACCEPT_EXT = ['.pdf', '.docx', '.md', '.markdown', '.txt']

function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function statusBadge(doc: DocumentInfo): { label: string; cls: string } {
  switch (doc.status) {
    case 'parsing':
      return { label: '解析中…', cls: 'bg-brand-bg text-brand-dark' }
    case 'failed':
      return { label: '失败', cls: 'bg-danger-bg text-danger' }
    case 'ready':
      return { label: `${doc.chunkCount} 片段`, cls: 'bg-paper text-ink2' }
  }
}

export function KnowledgeView({ onBack }: { onBack: () => void }) {
  const {
    kbs,
    currentKbId,
    docs,
    loading,
    importing,
    error,
    init,
    selectKb,
    createKb,
    pickAndImport,
    importPaths,
    removeDoc,
    reindex,
    clearError
  } = useKnowledge()

  const [dragOver, setDragOver] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)

  // M4：混合检索开关（设置持久化在 app_setting，问答检索时即时生效）
  const settings = useSettings((s) => s.settings)
  const saveSettings = useSettings((s) => s.save)
  const hybridOn = settings?.hybridSearchEnabled ?? true
  const toggleHybrid = () => {
    if (!settings) return
    void saveSettings({ ...settings, hybridSearchEnabled: !hybridOn })
  }

  // 进入页面时确保默认库与列表就绪（init 幂等）
  useEffect(() => {
    void init()
  }, [init])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      // File.path 在现代 Electron 已移除：唯一安全拿真实路径的方式是
      // preload 里经 webUtils.getPathForFile 解析
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => api.dialog.getPathForFile(f))
        .filter((p) => ACCEPT_EXT.includes(fileExt(p)))
      if (paths.length > 0) void importPaths(paths)
    },
    [importPaths]
  )

  const toggleChunks = async (doc: DocumentInfo) => {
    if (expanded === doc.id) {
      setExpanded(null)
      setChunks([])
      return
    }
    setExpanded(doc.id)
    setChunks([])
    setChunksLoading(true)
    try {
      setChunks(await api.knowledge.listChunks(doc.id))
    } finally {
      setChunksLoading(false)
    }
  }

  const submitCreate = async () => {
    await createKb(newName)
    setNewName('')
    setCreating(false)
  }

  return (
    <section className="flex h-full flex-1 flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-md px-2 py-1 text-sm text-ink2 hover:bg-card"
          >
            ← 返回对话
          </button>
          <span className="text-sm font-medium text-ink">知识库</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={currentKbId ?? ''}
            onChange={(e) => void selectKb(e.target.value)}
            className="rounded-md border border-line bg-card px-2 py-1 text-sm text-ink outline-none"
          >
            {kbs.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}（{k.docCount}）
              </option>
            ))}
          </select>
          {creating ? (
            <span className="flex items-center gap-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
                placeholder="知识库名称"
                className="w-32 rounded-md border border-brand px-2 py-1 text-sm outline-none"
              />
              <button onClick={() => void submitCreate()} className="text-sm text-brand">
                确定
              </button>
            </span>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="rounded-md px-2 py-1 text-sm text-ink2 hover:bg-card"
            >
              ＋ 新建
            </button>
          )}
          <button
            onClick={toggleHybrid}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
              hybridOn
                ? 'border-brand bg-brand-bg font-medium text-brand-dark'
                : 'border-line text-ink2 hover:bg-card'
            }`}
            title="混合检索：语义向量 + 关键词 BM25 双路召回后融合排序；关闭则仅用语义向量"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                hybridOn ? 'bg-brand' : 'bg-ink2/40'
              }`}
            />
            混合检索
          </button>
          <button
            onClick={() => void reindex()}
            disabled={importing}
            className="rounded-md px-2 py-1 text-sm text-ink2 hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
            title="更换 embedding 模型后重建全部向量"
          >
            重建索引
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start justify-between gap-3 border-b border-danger bg-danger-bg px-5 py-2 text-sm text-danger">
          <span>{error}</span>
          <button onClick={clearError} className="shrink-0 underline">
            知道了
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
          {/* 导入区：点击选择或直接拖入 */}
          <div
            onClick={() => void pickAndImport()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void handleDrop(e)}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
              dragOver ? 'border-brand bg-brand-bg' : 'border-line bg-card'
            }`}
          >
            <p className="text-sm font-medium text-ink">
              {importing ? '正在导入，请稍候…' : '拖入文件，或点击选择文件'}
            </p>
            <p className="mt-1 text-xs text-ink2">
              支持 PDF / Word（.docx）/ Markdown / TXT，内容只在本机处理
            </p>
          </div>

          {/* 文档列表 */}
          {loading ? (
            <p className="py-6 text-center text-sm text-ink2">加载中…</p>
          ) : docs.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink2">
              还没有文档，先导入几个文件吧。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.map((doc) => {
                const badge = statusBadge(doc)
                const open = expanded === doc.id
                return (
                  <li
                    key={doc.id}
                    className="rounded-lg border border-line bg-card"
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <button
                        onClick={() => doc.status === 'ready' && void toggleChunks(doc)}
                        className={`flex flex-1 items-center gap-2 text-left ${
                          doc.status === 'ready'
                            ? 'cursor-pointer text-ink hover:text-brand-dark'
                            : 'cursor-default text-ink'
                        }`}
                        title={doc.status === 'ready' ? '点击查看切分片段' : undefined}
                      >
                        <span className="text-sm">{open ? '▾' : '▸'}</span>
                        <span className="flex-1 truncate text-sm">{doc.fileName}</span>
                      </button>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${badge.cls}`}
                        title={doc.status === 'failed' ? doc.error ?? '' : undefined}
                      >
                        {badge.label}
                      </span>
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `确定删除文档「${doc.fileName}」吗？其全部片段与向量将被移除。`
                            )
                          ) {
                            void removeDoc(doc.id).then(() => {
                              if (open) {
                                setExpanded(null)
                                setChunks([])
                              }
                            })
                          }
                        }}
                        className="text-sm text-ink2 hover:text-danger"
                        title="删除文档"
                      >
                        ✕
                      </button>
                    </div>

                    {doc.status === 'failed' && doc.error && (
                      <p className="border-t border-line px-4 py-2 text-xs text-danger">
                        失败原因：{doc.error}
                      </p>
                    )}

                    {open && (
                      <div className="border-t border-line px-4 py-3">
                        {chunksLoading ? (
                          <p className="text-xs text-ink2">加载片段中…</p>
                        ) : chunks.length === 0 ? (
                          <p className="text-xs text-ink2">暂无片段</p>
                        ) : (
                          <ul className="flex flex-col gap-2">
                            {chunks.map((c) => (
                              <li
                                key={c.id}
                                className="rounded-md bg-paper px-3 py-2 text-xs"
                              >
                                <div className="mb-1 flex items-center gap-2 text-ink2">
                                  <span>#{c.chunkIndex + 1}</span>
                                  {typeof c.tokenCount === 'number' && (
                                    <span>≈{c.tokenCount} tokens</span>
                                  )}
                                  {typeof c.meta.page === 'number' && (
                                    <span>第 {c.meta.page} 页</span>
                                  )}
                                  {c.meta.headingPath && (
                                    <span className="truncate">{c.meta.headingPath}</span>
                                  )}
                                </div>
                                <p className="line-clamp-3 whitespace-pre-wrap text-ink">
                                  {c.content}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
