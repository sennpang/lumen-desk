import { create } from 'zustand'
import { api } from '../lib/ipc'
import type { UpdateState } from '../../../shared/types'

/**
 * 自动更新状态（electron-updater 的渲染端镜像）。
 *
 * 与 useChat/useKnowledge 同一套"主进程事件为唯一事实源"模型：
 * App 启动时订阅 update:event，打开设置弹窗前再 getState 补拉一次，
 * 避免"订阅早于/晚于主进程广播"的时序缝隙。
 * 后台静默检查发现新版本时，Sidebar 靠 hasUpdate 显示提示红点。
 */
interface UpdaterState {
  state: UpdateState | null
  /** 订阅主进程事件（App 全局只调一次） */
  subscribe: () => () => void
  /** 主动拉取当前状态 */
  refresh: () => Promise<void>
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => void
  /** 红点条件：已发现/下载中/已下载（error 与 not-available 不打扰） */
  hasUpdate: () => boolean
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  state: null,

  subscribe() {
    const off = api.updater.onState((s) => set({ state: s }))
    // 订阅后立刻补拉：主进程可能在渲染层订阅前就已广播
    void get().refresh()
    return off
  },

  async refresh() {
    set({ state: await api.updater.getState() })
  },

  async check() {
    set({ state: await api.updater.check(true) })
  },

  async download() {
    set({ state: await api.updater.download() })
  },

  install() {
    void api.updater.install()
  },

  hasUpdate() {
    const s = get().state?.status
    return s === 'available' || s === 'downloading' || s === 'downloaded'
  }
}))
