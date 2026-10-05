import { getDb } from '../../db/sqlite'
import { hasCloudApiKey } from '../../store/secrets'
import type { AppSettings, ModelProvider, SettingsView } from '../../../shared/types'

/**
 * 设置仓储：非密配置存 app_setting 表（单行 key-value），
 * 密钥不在这里（见 store/secrets.ts）。
 *
 * 存储方式：整张 AppSettings 序列化成一个 JSON，存 key='app' 的单行。
 * 对单用户桌面应用这比为每个字段建一行更简单，读取一次即可拿到全部配置；
 * 字段演进靠 TS 类型 + mergeDefaults 兜底。
 */

const SETTING_KEY = 'app'

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'cloud',
  // DeepSeek 官方 OpenAI 兼容端点（PRD F-B1 默认 DeepSeek）
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  // Ollama 默认本机端口；用 127.0.0.1 比 localhost 更稳（跳过 DNS 解析差异，断网也可达）
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: '',
  // embedding 默认走 Ollama：导入文档这条链路也能完全离线（PRD local-first）
  embeddingProvider: 'ollama',
  // nomic-embed-text 是 Ollama 官方文档推荐的通用嵌入模型（768 维，约 274MB）
  ollamaEmbedModel: 'nomic-embed-text',
  // 云端 embedding 需用户在设置里填：要求其 OpenAI 兼容网关同时提供
  // /v1/embeddings（DeepSeek 本身没有 embedding 接口，可选硅基流动/智谱/OpenAI）
  cloudEmbedModel: '',
  // M4：默认混合检索（向量 + 关键词 RRF），关掉则退化为 M3 纯向量
  hybridSearchEnabled: true,
  temperature: 0.7,
  systemPrompt: '你是 Lumen Desk，一个严谨、简洁的 AI 助手。',
  // 上下文保护阈值（估算 token）；超过则压缩早期对话（F-A2）
  maxContextTokens: 24000
}

export function getSettings(): AppSettings {
  const row = getDb()
    .prepare('SELECT value FROM app_setting WHERE key = ?')
    .get(SETTING_KEY) as { value: string } | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  // 与默认值合并：新版本新增字段时，老用户的存档也能自动补齐
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<AppSettings>) }
}

/** 渲染端视图：附带 hasApiKey，但永远不包含明文密钥 */
export function getSettingsView(): SettingsView {
  return { ...getSettings(), hasApiKey: hasCloudApiKey() }
}

export function saveSettings(settings: AppSettings): void {
  getDb()
    .prepare(
      `INSERT INTO app_setting(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(SETTING_KEY, JSON.stringify(settings))
}

export function setProvider(provider: ModelProvider): void {
  saveSettings({ ...getSettings(), provider })
}

/**
 * 从备份文件清洗出一份合法 AppSettings（M6 导入备份）。
 * 不信任文件内容：逐字段按类型/枚举校验，非法或缺字段一律回退默认值，
 * 且只挑已知字段，杜绝备份里夹带的额外键污染配置表。
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS
  if (!raw || typeof raw !== 'object') throw new Error('备份内容不是有效的设置对象')
  const r = raw as Record<string, unknown>
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    provider: r.provider === 'cloud' || r.provider === 'local' ? r.provider : d.provider,
    baseUrl: str(r.baseUrl, d.baseUrl),
    model: str(r.model, d.model),
    ollamaUrl: str(r.ollamaUrl, d.ollamaUrl),
    ollamaModel: str(r.ollamaModel, d.ollamaModel),
    embeddingProvider:
      r.embeddingProvider === 'ollama' || r.embeddingProvider === 'cloud'
        ? r.embeddingProvider
        : d.embeddingProvider,
    ollamaEmbedModel: str(r.ollamaEmbedModel, d.ollamaEmbedModel),
    cloudEmbedModel: str(r.cloudEmbedModel, d.cloudEmbedModel),
    hybridSearchEnabled:
      typeof r.hybridSearchEnabled === 'boolean'
        ? r.hybridSearchEnabled
        : d.hybridSearchEnabled,
    temperature: num(r.temperature, d.temperature),
    systemPrompt: str(r.systemPrompt, d.systemPrompt),
    maxContextTokens: Math.floor(num(r.maxContextTokens, d.maxContextTokens))
  }
}
