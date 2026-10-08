# M0 · Electron 骨架

> 对应提交：`a05362b` → `efe1a66`（共 15 个）
> 目标：不写任何业务逻辑，只回答一个问题——**Electron 三个进程怎么安全地串起来？**

## 解决什么问题

Electron 应用一启动就有三个 JS 世界，新手最容易把它们混成一个：

| 世界 | 运行时 | 能用什么 | 代码位置 |
|---|---|---|---|
| 主进程 main | Node.js | 全部 OS 能力（fs、网络、数据库、密钥） | `src/main/` |
| 预加载 preload | 受限 Node | `ipcRenderer` + 一小撮白名单 API | `src/preload/` |
| 渲染进程 renderer | Chromium | 只有 Web API（React 跑在这） | `src/renderer/` |

M0 的验收标准很朴素：渲染页面点一下按钮，通过 preload 调 `app:ping`，主进程返回版本号，页面显示出来。这条链路通了，后面所有功能都是在"往这条链路里加频道"。

## 架构与启动时序

```
electron-vite dev
   ├─ vite 起 renderer dev server (HMR)
   ├─ 编译 main/preload (TS→CJS/ESM)
   └─ 启动 Electron
        app.whenReady()
          ├─ ensureDataDirs()          userData 下建 vectors/ cache/
          ├─ initDb()                  M1 后才有内容，M0 是空架子
          ├─ registerIpcHandlers()     ipcMain.handle('app:ping', …)
          └─ createWindow()
               ├─ webPreferences: contextIsolation=true
               │                    nodeIntegration=false
               │                    preload = out/preload/index.js
               └─ loadURL(ELECTRON_RENDERER_URL)  // 开发态
                    或 loadFile(out/renderer/index.html)  // 打包态
```

IPC 方向只有两种，且在 M0 就定死：

- **render → main**：`ipcRenderer.invoke(频道, 参数)` → 主进程 `ipcMain.handle` 返回 Promise（请求-响应，禁止单向 `send` 火并）
- **main → render**：`webContents.send(频道, 事件)` 做服务端推送（M1 流式输出用到）

## 关键代码导读

- [src/main/index.ts](../../src/main/index.ts)：窗口创建与生命周期。重点看 `webPreferences` 的安全三件套、`ready-to-show` 后才 `show()`（防白屏闪烁）、渲染 console 转发到主进程终端
- [src/main/ipc/index.ts](../../src/main/ipc/index.ts)：处理器注册中心。M0 只有 `app:ping`，但它确立了"命名空间:动作"的频道命名规范
- [src/preload/index.ts](../../src/preload/index.ts)：`contextBridge.exposeInMainWorld('api', { ping })`——**整个应用唯一的跨进程边界**，渲染端看到的 `window.api` 就是这里逐个列出来的方法
- [src/preload/index.d.ts](../../src/preload/index.d.ts)：把 `Api` 类型挂到全局 window，渲染端有完整类型提示
- [src/main/paths.ts](../../src/main/paths.ts)：所有磁盘路径的单一事实来源，不要在业务代码里散写 `app.getPath('userData')`
- [electron.vite.config.ts](../../electron.vite.config.ts)：三段式构建；主/preload 用 `externalizeDepsPlugin`（npm 依赖不打进 bundle，为 M3 的原生模块埋伏笔）
- [src/renderer/index.html](../../src/renderer/index.html)：CSP meta 标签——`default-src 'self'`，从第一页就关掉 XSS 的大门

## 核心知识点

### 1. 安全三件套各自防什么

- `contextIsolation: true`：preload 的 JS 世界和页面的 JS 世界隔离。页面里被注入的恶意脚本摸不到 preload 内部，只能用我们显式暴露的 `window.api`
- `nodeIntegration: false`：页面里不能 `require('fs')`。React 应用永远不需要它
- CSP：即使有人往页面里注入了 `<script>`，也只允许同源脚本执行

三者缺一个，"网页被攻破"就会升级成"电脑被攻破"。

### 2. 为什么 preload 是窄 API 而不是整个 ipcRenderer

如果暴露 `ipcRenderer.send`，等于把"任意频道名"的调用权交给渲染层——将来加一个危险频道，所有历史页面都能调。暴露具体方法（`api.ping()`、`api.chat.run(payload)`），参数还有 TS 类型约束，攻击面就是白名单本身。

### 3. electron-vite 的三段构建 ≠ 一个 vite

- main / preload 构建为 Node 环境产物（CommonJS 风格，原生模块 external）
- renderer 是标准 Vite + React，产物是静态文件
- 开发态注入 `ELECTRON_RENDERER_URL`，生产态 `loadFile`——同一份入口代码靠环境变量切换

### 4. 国内网络的现实

`.npmrc` 里 `electron_mirror=https://npmmirror.com/mirrors/electron/` 是必需品，否则 postinstall 从 GitHub 拉 Electron 二进制大概率超时。

## 踩坑记录

- **Electron 44 的 `console-message` 签名变了**：旧教程是 `(event, level, message, line, sourceId)`，44 起是单参数 `details`（`details.level` 是字符串枚举 `'error' | 'info' …`）。照抄旧 API 会拿到 undefined，这个适配在 `d2faca4`。
- 外置 SSD 上执行 npm/git 会遇到沙箱跨设备（EXDEV）拦截——环境问题，与代码无关，但会让你怀疑人生。

## 自测题

1. 把 `contextIsolation` 设成 `false`，页面里的脚本会获得什么能力？为什么这很危险？
2. 为什么 preload 不能直接 `exposeInMainWorld('ipc', ipcRenderer)`？
3. 开发态和打包态，窗口分别加载什么？代码里靠哪个变量区分？
4. 主进程想主动给渲染端发消息用什么方法？M0 用到了吗（哪个里程碑开始用）？

## 自测题参考答案

**1. 把 `contextIsolation` 设成 `false`，页面里的脚本会获得什么能力？为什么这很危险？**

会失去"两个 JS 世界"的隔离：preload 脚本和网页运行在同一个 V8 上下文（同一个 `window`、同一套原型链）里。后果有两层：

- 直接后果：preload 里 `require('electron')` 拿到的 `ipcRenderer`、甚至通过 `require('child_process')` 等 Node 能力，对页面脚本不再是"只能看到 contextBridge 暴露的那几个方法"，而是可以顺着作用域链、原型链、全局对象被页面里任何脚本摸到（Electron 旧版本的沙箱逃逸 PoC 基本都建立在这之上）。
- 间接后果：网页脚本可以污染 `Object.prototype`、`Array.prototype` 等内置原型，preload 自己后续执行的逻辑也会被污染——即使 preload 没有显式泄露 API，隔离也已经不存在。

所以危险模型是：渲染端是最不可信的一层（要加载模型返回的 Markdown、未来可能加载远程内容、可能被 XSS 注入）。一旦隔离关闭，"网页里有恶意脚本"就直接等价于"恶意代码以当前用户权限在你的电脑上执行"（读文件、跑命令、偷 `secrets.enc`）。本项目的防线是三件套同时生效：`contextIsolation: true` 隔离世界、`nodeIntegration: false` 关掉页面侧的 require、CSP 限制可执行脚本来源。

**2. 为什么 preload 不能直接 `exposeInMainWorld('ipc', ipcRenderer)`？**

因为那等于把"频道名 + 参数"的全部自由度交给渲染端，白名单模型立刻崩塌：

- 现在的设计是渲染端只能调 `window.api.chat.run(payload)` 这样具名方法，主进程也只对固定频道注册 `ipcMain.handle`。攻击面 = 白名单里列出来的方法，且参数有 TS 类型约束、主进程还能在 handler 里做范围校验。
- 若暴露整个 `ipcRenderer`，渲染端就能 `ipcRenderer.invoke('任意频道', 任意参数)`。今天所有频道看起来都安全，但只要将来任何一个里程碑加了危险频道（比如保存文件、跑命令），所有历史页面、任何注入脚本不需要任何改动就能直接调它——安全边界随时间单调劣化。
- 具名方法还让"跨进程边界有哪些能力"在 [src/preload/index.ts](../../src/preload/index.ts) 一个文件里可审计；暴露通用总线后，审计对象散落在全部 IPC handler 里，无法判断谁有权调谁。

**3. 开发态和打包态，窗口分别加载什么？代码里靠哪个变量区分？**

见 [src/main/index.ts](../../src/main/index.ts)：

- 开发态：`win.loadURL(process.env.ELECTRON_RENDERER_URL)`——加载 electron-vite 启动的 Vite Dev Server 地址（http://localhost:某端口），支持 HMR 热更新。
- 打包态：`win.loadFile(join(__dirname, '../renderer/index.html'))`——加载 asar 内三端构建产物里的静态 HTML，全部资源走本地文件协议。
- 区分变量是 electron-vite 在开发态注入的环境变量 `process.env.ELECTRON_RENDERER_URL`（有值即开发态）。另一个语义等价的开关是 `app.isPackaged`（打包后为 true），项目里"行为差异"（DevTools、菜单、自动更新可用性）统一用 `app.isPackaged` 判断，"入口 URL 从哪来"用 env 判断——因为那个变量本身就携带 dev server 地址，一举两得。

**4. 主进程想主动给渲染端发消息用什么方法？M0 用到了吗（哪个里程碑开始用）？**

用窗口的 `webContents.send(频道, 数据)`（多窗口时遍历 `BrowserWindow.getAllWindows()` 广播）；渲染端在 preload 里用 `ipcRenderer.on(频道, listener)` 订阅。这是与 invoke/handle 请求-响应方向相反的"主 → 从"推送。

M0 没用到——M0 只有渲染端点按钮 → `app:ping` 一问一答。M1 开始大量使用：流式聊天的 token 一帧帧从主进程推给渲染端（`chat:event` 频道）。之后 M3 的 `kb:event`（导入进度）、M5 的 `confirm_required`（审批卡片）、自动更新的 `update:event` 都是同一模式。
