import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload 安全桥（PRD 13.1：preload 暴露面）
 *
 * 为什么需要它：
 * 渲染进程 contextIsolation:true + nodeIntegration:false，
 * 网页里既没有 require 也没有 ipcRenderer。preload 是唯一同时能接触
 * Node API（ipcRenderer）和页面 window 的地方，
 * 通过 contextBridge 把"白名单方法"挂到 window.api 上。
 *
 * 安全红线：
 * - 只暴露具体方法，绝不把 ipcRenderer 整个暴露出去
 * - 主进程返回什么，渲染进程就得到什么；密钥类数据永远不下发
 */
const api = {
  /** M0 健康检查：验证 IPC 链路 */
  ping: () => ipcRenderer.invoke('app:ping')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
