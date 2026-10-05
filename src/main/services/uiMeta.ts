import { getDb } from '../db/sqlite'

/**
 * UI 杂项状态（M6 首次引导标记等）。
 * 复用 app_setting 单行 key-value 表：这类"与文档无关的界面状态"
 * 不值得单独建表，一个 JSON 行即可，新增字段向后兼容（缺失即默认）。
 */

const META_KEY = 'ui_meta'

export interface UiMeta {
  /** 首次引导被关闭的时间戳；null=从未关闭，启动时应弹引导 */
  onboardingDismissedAt: number | null
}

const DEFAULT_META: UiMeta = {
  onboardingDismissedAt: null
}

export function getUiMeta(): UiMeta {
  const row = getDb()
    .prepare('SELECT value FROM app_setting WHERE key = ?')
    .get(META_KEY) as { value: string } | undefined
  if (!row) return { ...DEFAULT_META }
  // 与设置同理：逐字段兜底，老版本缺失字段自动补默认
  const parsed = JSON.parse(row.value) as Partial<UiMeta>
  return {
    onboardingDismissedAt:
      typeof parsed.onboardingDismissedAt === 'number'
        ? parsed.onboardingDismissedAt
        : DEFAULT_META.onboardingDismissedAt
  }
}

export function dismissOnboarding(): void {
  const next: UiMeta = { ...getUiMeta(), onboardingDismissedAt: Date.now() }
  getDb()
    .prepare(
      `INSERT INTO app_setting(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(META_KEY, JSON.stringify(next))
}
