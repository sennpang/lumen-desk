import { create } from 'zustand'
import { api } from '../lib/ipc'
import type { OllamaModelInfo, OllamaStatus, SaveSettingsInput, SettingsView } from '../../../shared/types'

/**
 * 设置页状态（F-B1/F-B3）。
 * API Key 永远只有 hasApiKey 布尔值；输入框的明文只活在组件本地 state。
 */
interface SettingsState {
  settings: SettingsView | null
  saving: boolean
  testing: boolean
  statusLine: { kind: 'ok' | 'error'; text: string } | null

  // Ollama 发现状态（F-B2）
  ollamaStatus: OllamaStatus | null
  ollamaModels: OllamaModelInfo[]
  checkingOllama: boolean

  load: () => Promise<void>
  save: (input: SaveSettingsInput) => Promise<void>
  test: () => Promise<void>
  clearStatus: () => void
  /** 探测服务；可用时顺带拉取模型列表（一次点击完成"发现+列模型"） */
  refreshOllama: () => Promise<void>
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  saving: false,
  testing: false,
  statusLine: null,
  ollamaStatus: null,
  ollamaModels: [],
  checkingOllama: false,

  async load() {
    set({ settings: await api.settings.get() })
  },

  async save(input) {
    set({ saving: true, statusLine: null })
    try {
      await api.settings.save(input)
      await api.settings.get().then((s) => set({ settings: s }))
      set({ statusLine: { kind: 'ok', text: '设置已保存' } })
    } catch (e) {
      set({ statusLine: { kind: 'error', text: e instanceof Error ? e.message : String(e) } })
    } finally {
      set({ saving: false })
    }
  },

  async test() {
    set({ testing: true, statusLine: null })
    try {
      await api.settings.testConnection()
      set({ statusLine: { kind: 'ok', text: '连接成功 ✓' } })
    } catch (e) {
      set({ statusLine: { kind: 'error', text: `连接失败：${e instanceof Error ? e.message : String(e)}` } })
    } finally {
      set({ testing: false })
    }
  },

  clearStatus() {
    set({ statusLine: null })
  },

  async refreshOllama() {
    set({ checkingOllama: true })
    try {
      // 用"已保存"的地址探测，所以先确保地址设置落库（由 UI 在保存后调用）
      const status = await api.ollama.status()
      if (status.available) {
        const models = await api.ollama.models()
        set({ ollamaStatus: status, ollamaModels: models })
      } else {
        set({ ollamaStatus: status, ollamaModels: [] })
      }
    } finally {
      set({ checkingOllama: false })
    }
  }
}))
