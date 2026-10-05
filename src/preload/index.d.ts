import type { Api } from './index'

/**
 * 把 preload 暴露的 Api 类型告知渲染进程：
 * 渲染端代码里 window.api 有完整类型提示与编译期检查。
 */
declare global {
  interface Window {
    api: Api
  }
}

export {}
