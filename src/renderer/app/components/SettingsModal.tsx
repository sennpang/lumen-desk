import { useEffect, useState } from 'react'
import { useSettings } from '../stores/useSettings'
import { api } from '../lib/ipc'
import type { AppAbout, OllamaModelInfo, OllamaStatus } from '../../../shared/types'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * 设置弹窗（F-B1/F-B3）：
 * 云端 Base / Key / 模型名、生成参数、系统提示词、上下文窗口。
 * Key 输入框不回显明文——占位符显示已配置状态，留空保存=不修改。
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const {
    settings,
    saving,
    testing,
    statusLine,
    ollamaStatus,
    ollamaModels,
    checkingOllama,
    load,
    save,
    test,
    refreshOllama
  } = useSettings()
  const [form, setForm] = useState({
    provider: 'cloud' as 'cloud' | 'local',
    baseUrl: '',
    model: '',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    embeddingProvider: 'ollama' as 'ollama' | 'cloud',
    ollamaEmbedModel: 'nomic-embed-text',
    cloudEmbedModel: '',
    hybridSearchEnabled: true,
    temperature: 0.7,
    systemPrompt: '',
    maxContextTokens: 24000,
    apiKey: ''
  })

  // 每次打开时用已保存设置重置表单
  useEffect(() => {
    if (open) {
      void load()
    }
  }, [open, load])

  useEffect(() => {
    if (settings) {
      setForm((f) => ({
        ...f,
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        ollamaUrl: settings.ollamaUrl,
        ollamaModel: settings.ollamaModel,
        embeddingProvider: settings.embeddingProvider,
        ollamaEmbedModel: settings.ollamaEmbedModel,
        cloudEmbedModel: settings.cloudEmbedModel,
        hybridSearchEnabled: settings.hybridSearchEnabled,
        temperature: settings.temperature,
        systemPrompt: settings.systemPrompt,
        maxContextTokens: settings.maxContextTokens
      }))
    }
  }, [settings])

  // 切到本地模型时自动探测一次（若尚无探测结果）
  useEffect(() => {
    if (open && form.provider === 'local' && !ollamaStatus && !checkingOllama) {
      void refreshOllama()
    }
  }, [open, form.provider, ollamaStatus, checkingOllama, refreshOllama])

  if (!open) return null

  const handleSave = () =>
    save({
      provider: form.provider,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      ollamaUrl: form.ollamaUrl.trim(),
      ollamaModel: form.ollamaModel,
      embeddingProvider: form.embeddingProvider,
      ollamaEmbedModel: form.ollamaEmbedModel.trim(),
      cloudEmbedModel: form.cloudEmbedModel.trim(),
      hybridSearchEnabled: form.hybridSearchEnabled,
      temperature: form.temperature,
      systemPrompt: form.systemPrompt,
      maxContextTokens: form.maxContextTokens,
      // 空字符串不透传：undefined 表示不修改密钥
      apiKey: form.apiKey.trim() ? form.apiKey.trim() : undefined
    }).then(() => {
      // 本地配置（地址）变更后，用新保存的地址重新探测
      if (form.provider === 'local') return refreshOllama()
    })

  const fieldCls =
    'w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-brand'
  const labelCls = 'mb-1 block text-xs font-medium text-ink2'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold">设置</h2>
          <button onClick={onClose} className="text-ink2 hover:text-ink">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* 模型来源 */}
          <div>
            <label className={labelCls}>模型来源</label>
            <div className="flex gap-2">
              <button
                onClick={() => setForm((f) => ({ ...f, provider: 'cloud' }))}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                  form.provider === 'cloud'
                    ? 'border-brand bg-brand-bg text-brand-dark'
                    : 'border-line text-ink2'
                }`}
              >
                云端模型
              </button>
              <button
                onClick={() => setForm((f) => ({ ...f, provider: 'local' }))}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                  form.provider === 'local'
                    ? 'border-brand bg-brand-bg text-brand-dark'
                    : 'border-line text-ink2'
                }`}
              >
                本地 Ollama（离线可用）
              </button>
            </div>
          </div>

          {form.provider === 'cloud' ? (
            <>
              <div>
                <label className={labelCls}>API Base（OpenAI 兼容）</label>
                <input
                  className={fieldCls}
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="https://api.deepseek.com"
                />
              </div>

              <div>
                <label className={labelCls}>模型名</label>
                <input
                  className={fieldCls}
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="deepseek-chat"
                />
              </div>

              <div>
                <label className={labelCls}>
                  API Key
                  <span className="ml-2 font-normal">
                    {settings?.hasApiKey ? '（已配置，留空表示不修改）' : '（未配置）'}
                  </span>
                </label>
                <input
                  type="password"
                  className={fieldCls}
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder={settings?.hasApiKey ? '••••••••••••' : 'sk-...'}
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-ink2">
                  Key 经系统密钥设施加密存储（macOS Keychain / Windows DPAPI），不会随日志上报。
                </p>
              </div>
            </>
          ) : (
            <OllamaSection
              status={ollamaStatus}
              models={ollamaModels}
              checking={checkingOllama}
              url={form.ollamaUrl}
              selectedModel={form.ollamaModel}
              onUrlChange={(v) => setForm((f) => ({ ...f, ollamaUrl: v }))}
              onSelectModel={(v) => setForm((f) => ({ ...f, ollamaModel: v }))}
              onRefresh={() => void refreshOllama()}
              fieldCls={fieldCls}
              labelCls={labelCls}
            />
          )}

          {/* Embedding 配置（M3 RAG 向量化用，与对话模型独立选择） */}
          <div className="rounded-lg border border-line p-3">
            <label className={labelCls}>知识库向量模型（Embedding）</label>
            <div className="flex gap-2">
              <button
                onClick={() => setForm((f) => ({ ...f, embeddingProvider: 'ollama' }))}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-xs ${
                  form.embeddingProvider === 'ollama'
                    ? 'border-brand bg-brand-bg text-brand-dark'
                    : 'border-line text-ink2'
                }`}
              >
                本地 Ollama
              </button>
              <button
                onClick={() => setForm((f) => ({ ...f, embeddingProvider: 'cloud' }))}
                className={`flex-1 rounded-lg border px-3 py-1.5 text-xs ${
                  form.embeddingProvider === 'cloud'
                    ? 'border-brand bg-brand-bg text-brand-dark'
                    : 'border-line text-ink2'
                }`}
              >
                云端 Embeddings
              </button>
            </div>

            <div className="mt-2">
              {form.embeddingProvider === 'ollama' ? (
                <>
                  <input
                    className={fieldCls}
                    value={form.ollamaEmbedModel}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, ollamaEmbedModel: e.target.value }))
                    }
                    placeholder="nomic-embed-text"
                  />
                  <p className="mt-1 text-xs text-ink2">
                    推荐 nomic-embed-text（本地离线、中英文效果均衡）。未安装时终端执行
                    <code className="mx-1 rounded bg-paper px-1 py-0.5">
                      ollama pull nomic-embed-text
                    </code>
                    。
                  </p>
                </>
              ) : (
                <>
                  <input
                    className={fieldCls}
                    value={form.cloudEmbedModel}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, cloudEmbedModel: e.target.value }))
                    }
                    placeholder="text-embedding-3-small"
                  />
                  <p className="mt-1 text-xs text-ink2">
                    走上方云端 Base/Key（OpenAI 兼容 /embeddings 接口）。注意：DeepSeek
                    目前不提供 embedding 接口，需要换用支持 embeddings 的服务商。
                  </p>
                </>
              )}
              <p className="mt-1 text-xs text-amber-700">
                ⚠ 更换向量模型后维度会变化，请在知识库页点「重建索引」，旧向量无法跨模型混用。
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>temperature：{form.temperature.toFixed(2)}</label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                className="w-full"
                value={form.temperature}
                onChange={(e) => setForm((f) => ({ ...f, temperature: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className={labelCls}>上下文窗口上限（tokens 估算）</label>
              <input
                type="number"
                min={1000}
                step={1000}
                className={fieldCls}
                value={form.maxContextTokens}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxContextTokens: Number(e.target.value) }))
                }
              />
            </div>
          </div>

          <div>
            <label className={labelCls}>系统提示词（System Prompt）</label>
            <textarea
              className={`${fieldCls} h-24 resize-none`}
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            />
          </div>

          {statusLine && (
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                statusLine.kind === 'ok'
                  ? 'bg-brand-bg text-brand-dark'
                  : 'bg-danger-bg text-danger'
              }`}
            >
              {statusLine.text}
            </p>
          )}

          <BackupSection onImported={() => void load()} />
          <AboutSection />
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button
            onClick={() => void test()}
            disabled={testing || saving}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-paper disabled:opacity-40"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------------- 备份与恢复（M6） ----------------

function BackupSection({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const handleExport = async () => {
    setBusy('export')
    setMsg(null)
    try {
      const r = await api.settings.exportBackup()
      if (!r.canceled) setMsg({ kind: 'ok', text: `已导出到：${r.path}` })
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${(e as Error).message}` })
    } finally {
      setBusy(null)
    }
  }

  const handleImport = async () => {
    setBusy('import')
    setMsg(null)
    try {
      const r = await api.settings.importBackup()
      if (r.canceled) return
      onImported()
      setMsg({
        kind: 'ok',
        text: r.hadApiKey
          ? '设置已导入。API Key 不随备份迁移，请重新填写并保存。'
          : '设置已导入并生效。'
      })
    } catch (e) {
      setMsg({ kind: 'err', text: `导入失败：${(e as Error).message}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink">备份与恢复</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink2">
            导出模型地址、参数、系统提示词等配置；API Key 与知识库内容不包含在备份中。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => void handleImport()}
            disabled={busy !== null}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-paper disabled:opacity-40"
          >
            {busy === 'import' ? '导入中…' : '导入'}
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={busy !== null}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-paper disabled:opacity-40"
          >
            {busy === 'export' ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
      {msg && (
        <p
          className={`mt-2 break-all rounded px-2 py-1 text-[11px] ${
            msg.kind === 'ok' ? 'bg-brand-bg text-brand-dark' : 'bg-danger-bg text-danger'
          }`}
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}

// ---------------- 关于（M6） ----------------

function AboutSection() {
  const [about, setAbout] = useState<AppAbout | null>(null)
  useEffect(() => {
    void api.about().then(setAbout).catch(() => setAbout(null))
  }, [])
  if (!about) return null
  const envLabel = `${about.platform}/${about.arch} · ${about.packaged ? '安装包' : '开发态'}`
  return (
    <details className="rounded-lg border border-line">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink2">
        关于 Lumen Desk
      </summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-3 pt-1 text-xs leading-relaxed text-ink2">
        <dt className="text-ink2/70">版本</dt>
        <dd className="font-mono">{about.version}</dd>
        <dt className="text-ink2/70">环境</dt>
        <dd>{envLabel}</dd>
        <dt className="text-ink2/70">Electron</dt>
        <dd className="font-mono">{about.electronVersion}</dd>
        <dt className="text-ink2/70">Chromium</dt>
        <dd className="font-mono">{about.chromeVersion}</dd>
        <dt className="text-ink2/70">Node</dt>
        <dd className="font-mono">{about.nodeVersion}</dd>
      </dl>
    </details>
  )
}

// ---------------- 本地 Ollama 配置区（F-B2） ----------------

interface OllamaSectionProps {
  status: OllamaStatus | null
  models: OllamaModelInfo[]
  checking: boolean
  url: string
  selectedModel: string
  onUrlChange: (v: string) => void
  onSelectModel: (v: string) => void
  onRefresh: () => void
  fieldCls: string
  labelCls: string
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

function OllamaSection(props: OllamaSectionProps) {
  const {
    status,
    models,
    checking,
    url,
    selectedModel,
    onUrlChange,
    onSelectModel,
    onRefresh,
    fieldCls,
    labelCls
  } = props

  return (
    <>
      <div>
        <label className={labelCls}>服务地址</label>
        <input
          className={fieldCls}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="http://127.0.0.1:11434"
        />
        <p className="mt-1 text-xs text-ink2">修改地址后请先「保存」，再点右侧检测。</p>
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm">
            {checking ? (
              <span className="text-ink2">正在检测本地服务…</span>
            ) : status?.available ? (
              <span className="font-medium text-brand-dark">
                ✓ 已连接 Ollama {status.version ?? ''}
              </span>
            ) : (
              <span className="font-medium text-danger">
                ✗ 未检测到运行中的 Ollama
                {status?.reason ? <span className="ml-1 text-xs">（{status.reason}）</span> : null}
              </span>
            )}
          </div>
          <button
            onClick={onRefresh}
            disabled={checking}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-paper disabled:opacity-40"
          >
            {checking ? '检测中…' : '重新检测'}
          </button>
        </div>

        {/* 服务可用：列模型 */}
        {status?.available && (
          <div className="mt-3">
            <label className={labelCls}>选择已安装模型</label>
            {models.length === 0 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                服务已连接，但还没有可用模型。请在终端执行
                <code className="mx-1 rounded bg-white px-1 py-0.5">ollama pull qwen2.5:7b</code>
                下载一个中文友好的 7B 模型，完成后点「重新检测」。
              </p>
            ) : (
              <select
                className={fieldCls}
                value={selectedModel}
                onChange={(e) => onSelectModel(e.target.value)}
              >
                {!selectedModel && <option value="">请选择模型…</option>}
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                    {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                    {m.quantization ? ` · ${m.quantization}` : ''}
                    {m.size ? ` · ${formatSize(m.size)}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* 服务不可用：安装引导（PRD F-B2：未安装时给出引导） */}
        {!checking && !status?.available && (
          <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-ink2">
            <p>按以下步骤启用本地模型：</p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>
                从{' '}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-dark underline"
                >
                  ollama.com/download
                </a>{' '}
                下载并安装 Ollama
              </li>
              <li>
                启动 Ollama 后，在终端执行
                <code className="mx-1 rounded bg-paper px-1 py-0.5">ollama pull qwen2.5:7b</code>
                下载模型
              </li>
              <li>回到这里点「重新检测」，选择模型后保存即可离线使用</li>
            </ol>
          </div>
        )}
      </div>
    </>
  )
}
