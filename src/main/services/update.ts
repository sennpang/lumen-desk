import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../../shared/types'

/**
 * 应用自动更新（electron-updater，GitHub Releases 为更新源）。
 *
 * 产品策略：启动 10s 后静默"检查"一次，菜单/设置里也可手动检查；
 * 发现新版本只通知、不自动下载（省流量、不抢启动带宽），用户在设置里
 * 点「下载」，下载完成后点「重启并安装」；autoInstallOnAppQuit 兜底，
 * 用户自然退出应用时也会把已下载好的包装上。
 *
 * 平台说明：
 * - Windows：NSIS 安装包 + latest.yml，完整支持静默安装
 * - macOS：走 Squirrel.Mac + zip + latest-<arch>-mac.yml。本项目未做
 *   Developer ID 签名，个别系统会拒绝安装，失败时 UI 引导去 Releases
 *   手动下载 dmg（见 README FAQ）
 * - Linux：未分发安装包，supported=false
 *
 * 更新元数据（app-update.yml）由 electron-builder 打包时从
 * electron-builder.yml 的 publish 段生成；开发环境没有该文件且
 * 版本号恒为 0.0.0，直接标记 unsupported，不做任何网络请求。
 */

/** mac 双架构分通道：CI 分别产出 latest-arm64-mac.yml / latest-x64-mac.yml */
function channelForPlatform(): string | null {
  if (process.platform !== 'darwin') return null
  return process.arch === 'arm64' ? 'latest-arm64' : 'latest-x64'
}

const supported = app.isPackaged && process.platform !== 'linux'
const STARTUP_CHECK_DELAY_MS = 10_000

let state: UpdateState = {
  status: supported ? 'idle' : 'unsupported',
  currentVersion: app.getVersion()
}
let initialized = false

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:event', state)
  }
}

/**
 * 注册 autoUpdater 事件 → 状态机。所有事件都落到同一个 UpdateState
 * 并广播给渲染端：autoUpdater 自己的 error 事件只 reject Promise
 * 不够用（下载阶段的失败没有对应的 Promise 调用点），必须事件驱动。
 */
export function initUpdater(): void {
  if (initialized) return
  initialized = true

  ipcMain.handle('update:get-state', () => state)
  ipcMain.handle('update:check', (_e, manual: boolean) =>
    checkForUpdates(manual)
  )
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => {
    // 退出前先让主进程常规退出钩子跑完（closeDb 等）；
    // isSilent=false：mac/Win 都弹正常安装流程而非强制静默
    if (state.status === 'downloaded') autoUpdater.quitAndInstall(false, false)
  })

  if (!supported) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  const channel = channelForPlatform()
  if (channel) autoUpdater.channel = channel
  // electron-updater 默认 logger 走 debug 包（默认不输出），这里接 console，
  // 打包态从终端启动 .app 二进制时能看到它实际请求的 yml 地址，便于排障
  autoUpdater.logger = {
    info: (m: unknown) => console.log(`[updater] ${m}`),
    warn: (m: unknown) => console.warn(`[updater] ${m}`),
    error: (m: unknown) => console.error(`[updater] ${m}`),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: undefined })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({ status: 'available', version: info.version, lastCheckedAt: Date.now() })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'not-available', lastCheckedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    setState({
      status: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      bytesTransferred: p.transferred,
      totalBytes: p.total
    })
  })
  autoUpdater.on('update-downloaded', () => {
    setState({ status: 'downloaded', percent: 100 })
  })
  autoUpdater.on('error', (err: Error) => {
    // 后台静默检查失败（断网/GitHub API 限流）不弹框，只落到状态里，
    // 用户手动打开设置时能看到原因；正在 downloading 时失败同理。
    setState({ status: 'error', error: err.message })
  })

  // 启动后延迟静默检查：避开启动期与渲染端抢网络/CPU；
  // 不 await——检查结果通过事件广播，窗口随时创建都能在 get-state 补拉
  setTimeout(() => {
    void checkForUpdates(false)
  }, STARTUP_CHECK_DELAY_MS)
}

async function checkForUpdates(manual: boolean): Promise<UpdateState> {
  if (!supported) return state
  // 检查中/下载中不重复发请求（electron-updater 内部也有判断，但这里
  // 要保证 UI 按钮连点不会产生并发 yml 请求）
  if (state.status === 'checking') return state
  if (state.status === 'downloading' || state.status === 'downloaded') return state
  try {
    setState({ status: 'checking', error: undefined })
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // error 事件已把状态置为 error 并广播；手动检查时兜底输出
    if (manual) console.error('[updater] 手动检查更新失败：', err)
  }
  return state
}

async function downloadUpdate(): Promise<UpdateState> {
  if (!supported) return state
  if (state.status !== 'available') return state
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    console.error('[updater] 下载更新失败：', err)
  }
  return state
}
