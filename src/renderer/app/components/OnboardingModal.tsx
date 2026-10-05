import { api } from '../lib/ipc'

interface OnboardingModalProps {
  onClose: () => void
  onOpenSettings: () => void
  onOpenKnowledge: () => void
}

/**
 * 首次引导（M6）：新用户装完应用面对空白对话区不知道先做什么，
 * 这里把最小上手路径压成三步：配模型 → 喂资料 → 提问/用智能体。
 * 「不再显示」即关闭的默认行为——状态持久化在 app_setting(ui_meta)，
 * 点"开始使用"或右上角关闭都会 dismiss。
 */
const STEPS = [
  {
    icon: '⚙️',
    title: '配置模型',
    body: '在设置里选择云端模型（OpenAI 兼容网关）或本地 Ollama。本地模型全程离线，对话与知识库都不出本机。'
  },
  {
    icon: '📚',
    title: '导入资料',
    body: '在知识库中导入 PDF / Word / Markdown / TXT，应用会自动切片、生成向量索引并支持混合检索。'
  },
  {
    icon: '💬',
    title: '开始提问',
    body: '普通对话直接聊；切到「RAG」基于知识库回答；切到「智能体」可自主检索、查时间，打开链接/保存笔记前会请你确认。'
  }
]

export function OnboardingModal({
  onClose,
  onOpenSettings,
  onOpenKnowledge
}: OnboardingModalProps) {
  const handleClose = () => {
    void api.dismissOnboarding().finally(onClose)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-card shadow-xl">
        <header className="border-b border-line px-6 py-4">
          <h2 className="text-lg font-semibold">欢迎使用 Lumen Desk</h2>
          <p className="mt-1 text-sm text-ink2">本地知识库 AI 桌面助手 · 三步上手</p>
        </header>

        <div className="space-y-4 px-6 py-5">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-bg text-base">
                {s.icon}
              </div>
              <div>
                <p className="text-sm font-medium">
                  <span className="mr-1.5 text-xs font-mono text-ink2">{i + 1}.</span>
                  {s.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink2">{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-3">
          <div className="flex gap-3 text-xs">
            <button
              onClick={() => {
                void api.dismissOnboarding().then(() => {
                  onClose()
                  onOpenSettings()
                })
              }}
              className="text-brand-dark hover:underline"
            >
              先去配置模型 →
            </button>
            <button
              onClick={() => {
                void api.dismissOnboarding().then(() => {
                  onClose()
                  onOpenKnowledge()
                })
              }}
              className="text-brand-dark hover:underline"
            >
              导入资料 →
            </button>
          </div>
          <button
            onClick={handleClose}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
          >
            开始使用
          </button>
        </footer>
      </div>
    </div>
  )
}
