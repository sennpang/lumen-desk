import { contextBridge, ipcRenderer } from 'electron'
import type { RunPayload, StreamEvent } from '../shared/protocol'
import type {
  ChatMode,
  ConversationInfo,
  MessageRecord,
  SaveSettingsInput,
  SettingsView
} from '../shared/types'

/**
 * Preload 安全桥（PRD 13.1：preload 暴露面）
 *
 * 唯一同时接触 ipcRenderer 与页面 window 的地方。
 * 安全红线不变：只暴露具体窄方法，绝不透传 ipcRenderer；
 * 密钥永不下发明文（settings 视图只有 hasApiKey）。
 */
const api = {
  /** M0 健康检查 */
  ping: () => ipcRenderer.invoke('app:ping'),

  chat: {
    /** 发起一次运行，返回 streamId；过程经 onEvent 推送 */
    run: (payload: RunPayload): Promise<string> => ipcRenderer.invoke('chat:run', payload),
    /** 停止生成（F-A1）：主进程中断对应 fetch，已生成内容保留 */
    stop: (streamId: string): Promise<void> =>
      ipcRenderer.invoke('chat:stop', streamId),
    /**
     * 订阅统一流式事件（PRD 13.2）。
     * 返回取消订阅函数——React useEffect 清理时必须调用，
     * 否则 StrictMode 重挂载会累积监听器。
     */
    onEvent: (cb: (e: StreamEvent) => void): (() => void) => {
      const listener = (_event: unknown, ev: StreamEvent) => cb(ev)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },

  conversation: {
    create: (mode: ChatMode = 'chat'): Promise<ConversationInfo> =>
      ipcRenderer.invoke('conv:create', mode),
    list: (): Promise<ConversationInfo[]> => ipcRenderer.invoke('conv:list'),
    get: (
      id: string
    ): Promise<{ conversation: ConversationInfo; messages: MessageRecord[] }> =>
      ipcRenderer.invoke('conv:get', id),
    rename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('conv:rename', id, title),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('conv:remove', id)
  },

  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    save: (input: SaveSettingsInput): Promise<void> =>
      ipcRenderer.invoke('settings:save', input),
    /** 测试"已保存"的配置；失败时 Promise reject 携带错误信息 */
    testConnection: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('settings:test')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
