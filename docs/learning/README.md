# Lumen Desk 学习讲义

> 本地知识库 AI 桌面助手（Electron + React 18 + TypeScript）的复盘式学习文档。
> 按实际开发的里程碑顺序组织，每一份都对应一段可运行、可 `git log` 追溯的代码。

## 这套讲义怎么读

每份讲义的固定结构：

1. **解决什么问题** —— 这个里程碑存在的理由，不写"正确的废话"
2. **架构与数据流** —— 一张文字版时序图，先建立全局再看代码
3. **关键代码导读** —— 带文件链接，按"入口 → 服务 → 存储"的顺序
4. **核心知识点** —— 面试/复盘时应该能复述出来的东西
5. **踩坑记录** —— 真实调试过的坑（都在对应 commit message 里有原始记录）
6. **自测题** —— 能答上来才算真懂；答不上来回去读哪段代码都标了

建议读法：先通读"架构与数据流"，再打开链接里的代码对照，最后合上讲义答自测题。
每份讲义末尾都附有「自测题参考答案」——建议先自己答一遍再对答案，答案结合了后续里程碑（M6 自动更新、全量备份等）的最终实现。

## 里程碑地图

| 阶段 | 讲义 | 一句话 | 关键技术 |
|---|---|---|---|
| M0 | [Electron 骨架](./M0-electron-骨架.md) | 把三进程空壳跑通 | contextIsolation / contextBridge / IPC 白名单 / electron-vite |
| M1 | [流式聊天](./M1-流式聊天.md) | 逐字输出 + 落库 + 可停止 | SSE 手写解析 / AbortController / SQLite WAL / 事件协议 |
| M2 | [本地模型 Ollama](./M2-本地模型Ollama.md) | 云端/本地双 provider 归一 | OpenAI 兼容协议 / safeStorage / 模型自动发现 |
| M3 | [RAG 知识库](./M3-RAG知识库.md) | 文档进去、引用出来 | 解析→切片→嵌入→HNSW→召回→引用 全链路 |
| M4 | [混合检索](./M4-混合检索.md) | 语义路 + 关键词路取长补短 | FTS5 trigram / BM25 / RRF / 词法重排 |
| M5 | [Agent 智能体](./M5-Agent智能体.md) | 模型自己决定调工具、调几轮 | OpenAI tools / SSE tool_calls 归并 / ReAct / 副作用审批 |
| M6 | [交付打包](./M6-交付打包.md) | 产出能装的 dmg/zip | asarUnpack 原生模块 / 生产加固 / 图标 / 不签名分发 |

## 项目地图（读代码先认门）

```
src/
├─ main/                    主进程（Node.js 环境：文件/网络/数据库/密钥）
│  ├─ index.ts              应用入口：窗口、生命周期、单实例、安全
│  ├─ paths.ts              userData 存储布局（单一事实来源）
│  ├─ db/                   schema.sql + 连接/迁移（WAL、幂等 ALTER）
│  ├─ ipc/                  IPC 频道处理器（chat/conversation/settings/…）
│  ├─ store/secrets.ts      safeStorage 加密密钥库
│  └─ services/
│     ├─ llm/               OpenAI 流式客户端、上下文压缩、provider 解析
│     ├─ rag/               parser→chunker→embedder→vectorStore→retriever→indexing
│     ├─ agent/             tools.ts / runner.ts(ReAct) / repo.ts
│     ├─ conversations/     会话消息仓储
│     ├─ knowledge/         知识库/文档/片段仓储（含 FTS5）
│     ├─ settings/          设置仓储
│     └─ uiMeta.ts          界面杂项状态（首次引导标记）
├─ preload/index.ts         contextBridge 白名单桥（渲染端 window.api）
├─ renderer/                React 18 + Zustand + Tailwind v4
│  └─ app/{components,stores,lib}
└─ shared/                  types.ts + protocol.ts（双进程只共享类型，不共享逻辑）
```

## 数据物理位置

运行时数据都在 `app.getPath('userData')` 下（macOS：`~/Library/Application Support/lumen-desk/`）：

```
lumen.db              SQLite：会话/消息/agent_step/知识库/文档/片段/FTS/设置
secrets.enc           safeStorage 加密的云端 API Key
vectors/{kbId}.index  HNSW 向量图（hnswlib-node）
cache/embeddings/     按"模型+文本"hash 的 embedding 缓存（省钱省时间）
```

## 三条贯穿始终的工程原则

1. **安全红线**：渲染进程永远拿不到 Node API 和明文密钥；跨进程只走 preload 里逐个声明的窄方法。
2. **先协议后实现**：每个里程碑第一步都是在 `shared/` 定类型与事件契约（M1 `a824175`、M3 `88a75d4`、M5 `aff30df`），主进程和渲染端对着同一份类型开发。
3. **每个原子改动一个 commit**：70+ 个提交各自能编译、message 里写清"做了什么/为什么/知识点/踩坑"。看不懂某段代码时，`git log --oneline -- <文件>` 是最好的注释。
