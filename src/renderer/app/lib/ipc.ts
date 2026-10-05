/**
 * window.api 的类型化入口（PRD 目录约定：renderer/app/lib/ipc.ts）
 *
 * 不做二次封装：preload 暴露的 api 已经是窄方法 + 完整类型，
 * 这里只把它取出来给组件用，组件代码一律 import { api }，
 * 避免到处写 window.api 也便于将来加 mock/日志装饰器。
 */
export const api: Window['api'] = window.api
