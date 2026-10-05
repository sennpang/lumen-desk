import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * electron-vite 构建配置
 *
 * 三段式配置，对应 Electron 的三种进程：
 * - main     主进程（Node.js），src/main/index.ts -> out/main/index.js
 * - preload  预加载脚本，       src/preload/index.ts -> out/preload/index.js
 * - renderer 渲染进程（浏览器），src/renderer/index.html 为入口
 */
export default defineConfig({
  main: {
    // 主进程里的 npm 依赖（better-sqlite3 等）不打进 bundle，
    // 运行时从 node_modules 加载 —— 原生模块必须 external，否则 .node 二进制会被打包破坏
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
