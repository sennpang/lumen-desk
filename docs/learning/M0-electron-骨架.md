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

> 上面两句话是"结论"。如果你看完仍然不理解"消息到底怎么过去的、为什么要分两种、Promise 是哪来的"，接着读下面这节——它用本项目的真实代码把两种通信拆到底。

## IPC 深入：两种通信方向的内部原理

### 0. 先建立物理模型：它们是两台"机器"

主进程和渲染进程不是两个模块，而是**两个独立的进程、两块独立的内存（两个 V8 堆）**：

- 渲染端的变量（React state、DOM 对象、函数）在 Chromium 进程里，主进程完全看不见；
- 主进程的 `Database` 连接、`fetch` 的 AbortController、文件句柄在 Node 进程里，渲染端也摸不到；
- 两边唯一能交换的东西是**可以被序列化成字节的消息**（Electron 内部用 Chromium 的 Mojo IPC + 结构化克隆，约等于 JSON 的超集：支持 Map/Set/Date/ArrayBuffer，但**不能传函数、类实例原型链、DOM 节点、活的 socket**）。

所以 IPC 调用**不是函数调用**，更像给另一台机器发快递：你打包一个普通对象 → 跨进程序列化 → 对方拆开还原成一个**新对象** → 对方干完活再寄一个包裹回来。记住"每次调用都要过序列化边界"，后面所有设计（为什么参数类型都在 shared/ 里定义成普通 interface、为什么 File 拿不到路径）都从这里推出。

### 1. 请求-响应方向：invoke / handle 到底干了什么

先看本项目三处真实代码。

**① 主进程注册"收件窗口"**（[src/main/ipc/index.ts](../../src/main/ipc/index.ts)）：

```ts
ipcMain.handle('app:ping', () => {
  return { pong: true, version: app.getVersion(), platform: process.platform, time: Date.now() }
})
```

`ipcMain.handle(频道, fn)` 的语义：在主进程登记一张表——"以后凡是有人 invoke `app:ping`，就调用 fn，把 fn 的返回值寄回去"。fn 可以是 async（返回 Promise），Electron 会等它 resolve；fn 里 throw 或 reject，渲染端那边的 Promise 就会 reject（Error.message 会被带过去）。

**② preload 把它包成一个窄方法**（[src/preload/index.ts](../../src/preload/index.ts)）：

```ts
const api = {
  ping: () => ipcRenderer.invoke('app:ping'),
  chat: {
    run: (payload: RunPayload): Promise<string> => ipcRenderer.invoke('chat:run', payload),
    stop: (streamId: string): Promise<void> => ipcRenderer.invoke('chat:stop', streamId),
  }
}
contextBridge.exposeInMainWorld('api', api)
```

**③ 渲染端 await 调用**（React 组件里）：

```ts
const info = await window.api.ping()   // { pong: true, version: '0.1.0', ... }
```

#### 拆开看：invoke 这一行内部发生了什么

`invoke` 不是魔法，它本质是"一次带编号的挂号信"。如果用最原始的 `send/on` 手写一遍，你需要这些东西：

```ts
// —— 以下伪代码：Electron 内部替你做的事（真实实现更复杂，但模型一致）——

// 渲染端：发请求的人
let seq = 0
const pending = new Map<number, { resolve: Function; reject: Function }>()

function myInvoke(channel: string, ...args: unknown[]) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })                    // ① 先把"回信时该找谁"存起来
    ipcRenderer.send('__myRequest__', { id, channel, args }) // ② 编号+频道名+参数打包寄出
  })
}
ipcRenderer.on('__myResponse__', (_e, msg) => {
  const waiter = pending.get(msg.id)                        // ③ 回信到了，按编号找到等信的人
  if (!waiter) return
  pending.delete(msg.id)
  msg.ok ? waiter.resolve(msg.value) : waiter.reject(new Error(msg.error))
})

// 主进程：收件窗口
ipcMain.on('__myRequest__', async (event, msg) => {
  try {
    const value = await handlers[msg.channel](...msg.args)  // 按频道名找到注册的函数
    event.sender.send('__myResponse__', { id: msg.id, ok: true, value })
  } catch (err) {
    event.sender.send('__myResponse__', { id: msg.id, ok: false, error: String(err) })
  }
})
```

理解了这段手写版，`invoke/handle` 就完全透明了，它只是官方把这套样板内置了：

1. 渲染端 invoke 时，Electron 自动生成一个**内部请求 id**，把 `{resolve, reject}` 存进内部 Map，发出的消息里带着这个 id、频道名和参数；
2. 主进程按频道名找到 handle 注册的函数，把**克隆出来的参数**传进去调用；
3. 函数返回值（或 async 函数 resolve 的值、throw 的错误）被克隆后，连同原 id 寄回渲染端；
4. 渲染端按 id 从 Map 找到那个 Promise 的 resolve/reject 并 settle，然后删掉 id。

**两个关键推论：**

- **返回值为什么自动就是 Promise**：因为跨进程往返是异步的，回信时间未知，只能用 Promise 挂起等待。即使主进程函数是同步的（`app:ping` 立即 return），渲染端拿到的依然是 Promise。
- **一个 Promise 只能 resolve 一次**：这决定了 invoke 天然只适合"一问一答"。如果主进程对一次调用要连续回 N 条消息（流式 token），Promise 模型表达不了——这就是必须有第二种通信方向的根本原因（见下节）。

#### 为什么禁止渲染端用 send 单向"火并"

因为如果 render→main 全部用 `send/on`，上面手写版里的**请求编号、回信关联、错误回传、超时清理**全都要每个业务自己重造一遍，而且几乎必然漏掉错误回执：主进程 handler 抛了异常，渲染端还在傻等。项目的约定（见 [ipc/index.ts](../../src/main/ipc/index.ts) 顶部注释）是：**凡是渲染端发起、需要主进程做一件事的，一律 invoke**——哪怕不需要返回值（如 `chat:stop`），也用 invoke 返回 `void`，好处是主进程执行出错时渲染端能 catch 到、调用链可追踪。

#### 参数过边界：为什么 shared/types.ts 里全是普通 interface

invoke 的参数和返回值都要结构化克隆。所以：

- `RunPayload`、`ConversationInfo` 这类跨进程类型全部定义在 [shared/types.ts](../../src/shared/types.ts)，且只能是普通对象/数组/字符串/数字/布尔/null——没有方法、没有类。渲染端传一个带函数的对象过去，函数会被克隆成 `undefined`。
- 浏览器的 `File` 对象过边界后**不带磁盘路径**（安全考虑），所以拖拽文件必须在 preload 里用 `webUtils.getPathForFile(file)` 先把路径变成字符串（M3 的坑）。
- 主进程的 WebContents、Database 这类活对象永远不能传，只传 id（uuid 字符串），对方再用 id 找自己这边的对象——下一节的 `streamId`、`confirmId` 都是这个套路。

### 2. 服务端推送方向：webContents.send / ipcRenderer.on

当主进程要**主动、不定时、连续多次**给渲染端消息时（典型：模型一个字一个字地吐），用推模式。真实代码三处：

**① 主进程发送**（[src/main/ipc/chat.ts](../../src/main/ipc/chat.ts)）：

```ts
function emit(target: WebContents, event: StreamEvent): void {
  target.send('chat:event', event)      // 没有返回值，不等任何人
}
```

`target`（一个 WebContents）从哪来？每个 handle 回调的第一个参数是 IpcMainEvent，它的 `event.sender` 就是"发起这次请求的那个窗口"：

```ts
ipcMain.handle('chat:run', (event, payload: RunPayload): string => {
  const streamId = randomUUID()
  void executeRun(event.sender, streamId, payload)  // 不 await！后台去跑
  return streamId                                    // invoke 立刻拿到 id
})
```

注意这个分工：**invoke 只负责"下单"，立刻返回一张订单号（streamId）；真正的生成在后台异步进行，过程中产生的一切都走推送。** 多窗口广播时则遍历 `BrowserWindow.getAllWindows()` 逐个 send（自动更新 `update:event` 就是这么做的）。

**② preload 提供订阅，而不是发送权**：

```ts
onEvent: (cb: (e: StreamEvent) => void): (() => void) => {
  const listener = (_event: unknown, ev: StreamEvent) => cb(ev)
  ipcRenderer.on('chat:event', listener)
  return () => ipcRenderer.removeListener('chat:event', listener)  // 退订
}
```

这里有两个细节，都值得讲透：

- **包一层 listener 再传进去**：`ipcRenderer.on` 回调的第一个参数是 IpcRendererEvent（包含 sender、ports 等主进程引用），不应该让业务层碰到。外层 listener 把它丢弃，只把业务数据 `ev` 交给 cb。
- **必须返回退订函数**：`ipcRenderer.on` 是往一张全局监听器表里加条目，不加清理就会泄漏——React 组件卸载后回调还挂着，闭包里的 setState/store 引用无法回收，开发态 StrictMode 重挂载还会翻倍累积。退订时传的必须是**同一个函数引用**，所以要把 listener 存下来。

**③ 渲染端全局订阅一次，事件进唯一 reducer**（[src/renderer/App.tsx](../../src/renderer/App.tsx)）：

```ts
useEffect(() => {
  const offChat = api.chat.onEvent((ev) => { void useChat.getState().handleEvent(ev) })
  return () => offChat()        // 卸载即退订
}, [])
```

`handleEvent` 按事件的 `type` 字段做 switch（start/token/citation/done/error…），把状态写进 Zustand，React 自动重渲染。**订阅是"应用级一次"，不是"每发一句话订阅一次"**——监听器始终在，靠事件内容区分是谁的消息。

#### streamId：为什么频道只有一个，事件里却要带 id

主进程可能同时有多次运行（上一轮还没停又发新消息、未来多窗口）。如果为每次运行开一个动态频道（`chat:event:${streamId}`），渲染端每次发送前要 on、结束后要 removeListener，错一步就串流或泄漏。本项目的选择（见 [shared/protocol.ts](../../src/shared/protocol.ts) 注释）：

- **频道名固定** `chat:event`，所有运行的事件都从这一条路下来；
- **每个事件都带 streamId**，渲染端只处理"自己当前 activeRun 的 streamId"匹配的事件，其余忽略。

这就是"一条总线 + 信封上的流水号"模型：频道是邮政系统（固定、注册一次），streamId 是每封信上的订单号（动态、随业务创建销毁）。M5 的 `confirmId`、知识库事件的 `kbId/docId` 全是同一个模式。

#### 推模式没有回执：错误和结束也必须是事件

`webContents.send` 发完就完，没有 Promise、主进程不知道渲染端处没处理成功。所以流式协议必须把"正常结束"和"出错"也设计成事件，由主进程主动推：

```ts
type StreamEvent =
  | { type: 'start'; streamId; conversationId; messageId }  // 订单开始，带回消息 id
  | { type: 'token'; streamId; delta: string }              // N 次：增量文本
  | { type: 'citation'; streamId; chunkId; ... }            // RAG 引用
  | { type: 'agent_step' | 'confirm_required'; ... }        // M5 Agent 过程/审批
  | { type: 'done'; streamId; usage }                       // 正常收尾（唯一一次）
  | { type: 'error'; streamId; message }                    // 异常收尾（唯一一次）
```

渲染端收到 done/error 才知道"这条流结束了"，可以恢复输入框、清理 activeRun。反过来主进程也要有反向通道让用户干预流——那是另一个 invoke：`chat:stop`（按 streamId 找到 AbortController 中断）、`chat:confirm-resolve`（按 confirmId 唤醒挂起的审批 Promise）。**推送和请求-响应不是互斥的，流式功能恰好是两者配合**：invoke 下单/控制，send 持续播报。

### 3. 一张图总结：ping（一问一答）和 chat（流式）的完整时序

`app:ping`——只有 invoke，四个步骤：

```
Renderer                 IPC 边界                  Main
   │  ipcRenderer.invoke('app:ping')                 │
   │  ── 消息{id:1, channel, args} 序列化 ──────────▶ │ ipcMain 查表找 handler
   │                         (等待中，Promise pending)│ fn() 执行（可访问 app/OS）
   │  ◀── {id:1, value:{pong,version…}} ─────────── │ 返回值克隆
   │  Promise resolve，await 继续                     │
```

`chat:run`——invoke 下单 + N 次推送 + invoke 控制：

```
Renderer                     Main
   │ invoke('chat:run', payload) ─▶ 生成 streamId，后台 executeRun（不 await）
   │ ◀── 立刻 return streamId
   │                              emit start      ── send('chat:event') ──▶ onEvent → reducer
   │                              emit token×N    ── send ... ──▶ 气泡逐字追加
   │  （用户点停止）                                 │
   │ invoke('chat:stop', streamId) ─▶ AbortController.abort()
   │                              emit done/error ── send ... ──▶ 收尾，恢复输入框
```

### 4. 选型规则（以后自己写功能时照这个判断）

| 场景 | 用什么 | 项目里的例子 |
|---|---|---|
| 渲染端要数据/要主进程做一件事，等一个结果 | invoke / handle | `conv:list`、`settings:save`、`kb:chunk`、`app:ping` |
| 不需要结果但要知道成功失败 | 仍然 invoke，返回 `{ok:true}` | `chat:stop`、`kb:remove` |
| 主进程不定时、多次地汇报 | webContents.send + 固定频道 + 事件带 id | token 流、kb 导入进度、更新下载进度 |
| 长任务 | invoke 立即返回任务 id + 推送过程事件 | `chat:run`、`kb:import` |
| 用户在任务中途干预 | 另开 invoke，按 id 找主进程里的任务对象 | `chat:stop`、`chat:confirm-resolve` |

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
5. 渲染端把一个"带方法的类实例"通过 invoke 传给主进程会发生什么？File 对象过边界为什么拿不到磁盘路径？这条边界规则怎样决定了 shared/types.ts 的形态？
6. 不看代码，用最原始的 `send/on` 手写一个 invoke：渲染端和主进程各自要维护什么？主进程 handler 抛错时渲染端怎么知道？这套机制解释了 invoke 的哪两个天生特性？
7. 同一条 `chat:event` 频道上同时有两次流式回答在跑，渲染端靠什么不把两次的 token 串在一起？为什么不开 `chat:event:${streamId}` 动态频道？preload 退订时为什么必须传回当初 on 的同一个函数引用？

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

**5. 渲染端把一个"带方法的类实例"通过 invoke 传给主进程会发生什么？File 对象过边界为什么拿不到磁盘路径？这条边界规则怎样决定了 shared/types.ts 的形态？**

两个进程是两个独立的 V8 堆，参数跨边界走的是**结构化克隆**（深拷贝普通数据，不是传引用）。结构化克隆只搬数据不搬行为：

- 带方法的类实例过去之后，原型链和方法全部丢失，函数属性被克隆成 `undefined`，主进程收到的只是一个形状相似的普通对象；
- 活对象（WebContents、Database 连接、AbortController）永远不能过边界，只能传一个 id 字符串，对方拿 id 在自己这边的注册表里找对象——streamId、confirmId、kbId 全是这个套路；
- File 对象能克隆出文件的名字/大小/二进制内容，但**故意不带磁盘绝对路径**（Chromium 的安全设计：网页不该知道用户磁盘结构）。所以 M3 拖拽导入必须在 preload 里调 `webUtils.getPathForFile(file)` 先把路径转成字符串再传。

这条规则直接决定了 [shared/types.ts](../../src/shared/types.ts) 的形态：跨进程类型（`RunPayload`、`ConversationInfo`、`StreamEvent`……）全部是纯 interface——普通对象、数组、字符串、数字、布尔、null，没有类、没有方法。先定义在 shared/ 还有一个额外好处：主进程和渲染端对着同一份类型编译，边界两侧不可能对报文形状理解不一致。

**6. 不看代码，用最原始的 `send/on` 手写一个 invoke：渲染端和主进程各自要维护什么？主进程 handler 抛错时渲染端怎么知道？这套机制解释了 invoke 的哪两个天生特性？**

渲染端维护三样东西：一个自增请求序号 `seq`、一张 `pending: Map<id, {resolve, reject}>`、一个固定的回信监听器。每次调用：`new Promise` 里把它的 resolve/reject 以新 id 存进 Map，再 `send('__myRequest__', {id, channel, args})`；监听器收到 `__myResponse__` 按 id 查到 waiter、从 Map 删除、按 `ok` 标志 resolve 或 reject。主进程维护一张频道→处理函数分发表：收到请求按 channel 找函数执行，成功回 `{id, ok:true, value}`，try/catch 到异常回 `{id, ok:false, error: String(err)}`——回信靠 `event.sender.send` 找回来时那个窗口。

这套手写版解释了 invoke 的两个天生特性：

1. **返回值必然是 Promise**：跨进程往返是异步的，回信时间未知，只能先挂起一个 Promise 等编号回信；主进程函数即使同步 return，渲染端拿到的也是 Promise。
2. **一个 Promise 只能 settle 一次，所以 invoke 天生只适合一问一答**：一次调用对应一条成功/失败回信。主进程要连续推 N 条（流式 token）Promise 模型表达不了，必须另走 `webContents.send` 推送方向。另外错误回执是这张表的必备行，不是可选功能——项目约定"哪怕不要返回值也用 invoke"（如 `chat:stop`），图的就是主进程出错时渲染端能 catch 到。

**7. 同一条 `chat:event` 频道上同时有两次流式回答在跑，渲染端靠什么不把两次的 token 串在一起？为什么不开 `chat:event:${streamId}` 动态频道？preload 退订时为什么必须传回当初 on 的同一个函数引用？**

靠事件信封上的 **streamId**：频道只有一条固定的 `chat:event`，所有运行的事件都从这一条总线下来，每个事件都带 streamId；渲染端全局只订阅一次，reducer 里只处理与"当前 activeRun 的 streamId"匹配的事件，不匹配的直接忽略。这是"一条总线 + 信封流水号"：频道是邮政系统（固定、注册一次），streamId 是每封信的订单号（动态、随业务创建销毁）。

不开动态频道的原因：动态频道要求每次发送前 `on('chat:event:'+id)`、结束后 `removeListener`，多窗口/多并发时每个组件都可能重复订阅，错一步就串流或泄漏；固定频道把"注册/退订一次"和"按内容分流"两个问题彻底分开，M5 的 confirmId、M3 的 kbId/docId 复用的是同一个模式。

退订必须传同一个函数引用，因为 `ipcRenderer.on/off` 的监听器表按函数身份匹配，内部还包了一层 listener（剥掉 IpcRendererEvent，只把业务数据交给回调）。如果退订时临时写一个新箭头函数，表中查不到、旧监听器永远不摘——React 组件卸载后闭包里的 setState/store 仍被引用，开发态 StrictMode 双重挂载还会让监听器翻倍累积。所以 preload 把 listener 存下来、由返回的退订函数闭包引用它。
