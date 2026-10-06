import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { ensureDataDirs } from './paths'
import { initDb, closeDb } from './db/sqlite'
import { registerIpcHandlers } from './ipc'

/**
 * 主进程入口（PRD 第 9 章：双进程模型）
 *
 * 职责边界：
 * - 主进程 = Node.js 环境，独占密钥/文件系统/网络/数据库
 * - 渲染进程 = Chromium 网页，只做 UI，通过 preload 白名单桥与主进程通信
 */

// 单实例锁（PRD 交付质量）：桌面应用重复点击图标应唤起已有窗口，
// 而不是启动第二个进程去抢同一个 SQLite（WAL 虽允许多连接，但两个
// 应用实例会让后台导入/Agent 任务与托盘行为全部重复）。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) void win.restore()
    win.show()
    win.focus()
  })
}

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
      sandbox: false, // preload 里要用 ipcRenderer，需关闭 sandbox（contextIsolation 仍生效）
      // 打包后不暴露 DevTools 给普通用户（dev/preview 不受影响，仍可菜单/快捷键打开）
      devTools: !app.isPackaged
    }
  })

  // 页面加载完成后再显示窗口
  win.on('ready-to-show', () => win.show())

  // 把渲染进程的 console 输出转发到主进程终端
  // （渲染进程没有终端窗口，不转发则页面里的 console.log 无处可看；
  //   后续调试流式事件、Agent 时间线都依赖这条日志通道）
  // Electron 44 新签名：单参数 details，level 为字符串枚举
  win.webContents.on('console-message', (details) => {
    const prefix = details.level === 'error' ? '[renderer:error]' : '[renderer]'
    console.log(`${prefix} ${details.message}`)
  })

  // 外部链接一律交给系统浏览器，绝不在应用内打开第三方页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 导航加固：应用是单页壳，任何整页导航（含被注入的
  // window.location/恶意 <a target=_self>）都拒绝；外链改由上面的
  // openExternal 通道处理，http(s) 放行到系统浏览器，其余静默拦截。
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  // electron-vite 约定：开发模式注入 ELECTRON_RENDERER_URL（Vite Dev Server 地址，支持 HMR）；
  // 生产模式加载构建产物 out/renderer/index.html
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 打包后裁剪应用菜单：去掉含"重新加载/开发者工具"的 View 等菜单，
// 桌面产品不应露出 Chromium 调试入口；但不能整体置空——
// macOS 的 Cmd+C/V/X/A/Z 等文本编辑快捷键由系统标准 Edit 菜单承载，
// setApplicationMenu(null) 会让输入框里复制粘贴/全选/撤销全部失效。
// 用 role 角色菜单只保留 App / Edit / Window 三组，标签和快捷键都由
// 系统按当前语言自动提供，无需自己绑 accelerator。
function buildPackagedMenu(): Menu {
  return Menu.buildFromTemplate([
    // appMenu：关于 / 服务 / 隐藏 / 退出（macOS 惯例的第一栏，名称取 app.name）
    { role: 'appMenu' },
    // editMenu：Undo/Redo/Cut/Copy/Paste/Select All，快捷键的关键
    { role: 'editMenu' },
    // windowMenu：最小化/缩放/关闭 + 窗口列表
    { role: 'windowMenu' }
  ])
}

// Electron 就绪后才能创建窗口 / 访问 userData
app.whenReady().then(() => {
  // macOS 保留角色菜单；Windows/Linux 下 autoHideMenuBar 已默认隐藏，
  // 直接置空即可（这两个平台编辑快捷键不依赖应用菜单）。
  if (app.isPackaged) {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(buildPackagedMenu())
    } else {
      Menu.setApplicationMenu(null)
    }
  }

  ensureDataDirs()
  initDb()
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

// 退出前关闭数据库连接（WAL 模式下顺带做 checkpoint，避免残留 -wal 膨胀）
app.on('before-quit', () => {
  closeDb()
})
