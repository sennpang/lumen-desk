import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { ensureDataDirs } from './paths'
import { registerIpcHandlers } from './ipc'

/**
 * 主进程入口（PRD 第 9 章：双进程模型）
 *
 * 职责边界：
 * - 主进程 = Node.js 环境，独占密钥/文件系统/网络/数据库
 * - 渲染进程 = Chromium 网页，只做 UI，通过 preload 白名单桥与主进程通信
 */

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false, // 等 ready-to-show 再显示，避免白屏闪烁
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全三件套（PRD 第 17 章，Electron 官方强推荐）：
      contextIsolation: true, // 渲染进程与 preload 的 JS 世界隔离，网页摸不到 bridge 内部
      nodeIntegration: false, // 渲染进程禁止直接使用 Node API
      sandbox: false // preload 里要用 ipcRenderer，需关闭 sandbox（contextIsolation 仍生效）
    }
  })

  // 页面加载完成后再显示窗口
  win.on('ready-to-show', () => win.show())

  // 外部链接一律交给系统浏览器，绝不在应用内打开第三方页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite 约定：开发模式注入 ELECTRON_RENDERER_URL（Vite Dev Server 地址，支持 HMR）；
  // 生产模式加载构建产物 out/renderer/index.html
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Electron 就绪后才能创建窗口 / 访问 userData
app.whenReady().then(() => {
  ensureDataDirs()
  registerIpcHandlers()
  createWindow()

  // macOS 惯例：点击 Dock 图标时若没有窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 非 macOS 平台：所有窗口关闭后退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
