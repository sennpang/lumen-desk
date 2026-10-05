import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { KbEvent, RunPayload, StreamEvent } from '../shared/protocol'
import type {
  ChatMode,
  ChunkInfo,
  ConversationInfo,
  DocumentInfo,
  KnowledgeBaseInfo,
  MessageRecord,
  OllamaModelInfo,
  OllamaStatus,
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
    /** M5：审批副作用工具（打开链接/保存文件）；approved=false 视为拒绝 */
    resolveConfirm: (confirmId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('chat:confirm-resolve', { confirmId, approved }),
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
  },

  ollama: {
    /** 探测本地 Ollama 服务（不抛错，读 available/reason） */
    status: (): Promise<OllamaStatus> => ipcRenderer.invoke('ollama:status'),
    /** 列出已安装模型；服务不可达时 reject */
    models: (): Promise<OllamaModelInfo[]> => ipcRenderer.invoke('ollama:models')
  },

  knowledge: {
    listKbs: (): Promise<KnowledgeBaseInfo[]> => ipcRenderer.invoke('kb:list'),
    ensureDefaultKb: (): Promise<KnowledgeBaseInfo> =>
      ipcRenderer.invoke('kb:ensure-default'),
    createKb: (name: string): Promise<KnowledgeBaseInfo> =>
      ipcRenderer.invoke('kb:create', name),
    listDocs: (kbId: string): Promise<DocumentInfo[]> =>
      ipcRenderer.invoke('kb:docs', kbId),
    /** 文档片段预览（点击文档查看切分结果，上限 500 条） */
    listChunks: (docId: string): Promise<ChunkInfo[]> =>
      ipcRenderer.invoke('kb:chunks', docId),
    /** 引用点击：取单个片段原文 */
    getChunk: (chunkId: string): Promise<ChunkInfo | null> =>
      ipcRenderer.invoke('kb:chunk', chunkId),
    /** 导入本地文件（后台处理，过程经 onKbEvent 推送） */
    importFiles: (kbId: string, filePaths: string[]): Promise<{ queued: boolean }> =>
      ipcRenderer.invoke('kb:import', kbId, filePaths),
    /** 重建向量索引（换 embedding 模型后使用，await 到完成） */
    reindex: (
      kbId: string
    ): Promise<{ docCount: number; chunkCount: number }> =>
      ipcRenderer.invoke('kb:reindex', kbId),
    removeDoc: (docId: string): Promise<void> =>
      ipcRenderer.invoke('kb:remove-doc', docId),
    /** 订阅导入生命周期事件；返回取消订阅函数 */
    onKbEvent: (cb: (e: KbEvent) => void): (() => void) => {
      const listener = (_event: unknown, ev: KbEvent) => cb(ev)
      ipcRenderer.on('kb:event', listener)
      return () => ipcRenderer.removeListener('kb:event', listener)
    }
  },

  dialog: {
    /** 系统文件选择框（多选），取消时返回空数组 */
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
    /**
     * 拖拽文件解析真实磁盘路径。
     * 渲染端 File 对象在安全模型下没有 path 属性（Electron 已移除），
     * 必须在 preload 里经 webUtils 解析；主进程只信任这里出来的路径。
     */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
