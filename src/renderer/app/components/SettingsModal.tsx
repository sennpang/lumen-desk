import { useEffect, useState } from 'react'
import { useSettings } from '../stores/useSettings'

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
  const { settings, saving, testing, statusLine, load, save, test } = useSettings()
  const [form, setForm] = useState({
    provider: 'cloud' as 'cloud' | 'local',
    baseUrl: '',
    model: '',
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
        temperature: settings.temperature,
        systemPrompt: settings.systemPrompt,
        maxContextTokens: settings.maxContextTokens
      }))
    }
  }, [settings])

  if (!open) return null

  const handleSave = () =>
    save({
      provider: form.provider,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      temperature: form.temperature,
      systemPrompt: form.systemPrompt,
      maxContextTokens: form.maxContextTokens,
      // 空字符串不透传：undefined 表示不修改密钥
      apiKey: form.apiKey.trim() ? form.apiKey.trim() : undefined
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
                disabled
                title="M2 里程碑支持"
                className="flex-1 cursor-not-allowed rounded-lg border border-line px-3 py-2 text-sm text-ink2 opacity-50"
              >
                本地 Ollama（M2）
              </button>
            </div>
          </div>

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
