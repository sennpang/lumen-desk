# Lumen Desk

> 本地知识库 AI 桌面助手 —— Local-first RAG + Agent。对话、文档、向量索引全部留在本机。

Lumen Desk 是一个基于 Electron 的桌面应用，把本地大模型（Ollama）或任意 OpenAI 兼容云端接口与你自己的文档库结合：支持普通聊天、带引用溯源的知识库问答（RAG），以及可调用工具的 Agent 模式。数据默认存储在本机 SQLite，不依赖任何后端服务。

## 功能特性

- **三种对话模式**
  - 聊天：直接与模型对话，支持中断、重新生成、单条复制
  - RAG：自动从知识库检索相关片段，回答附带来源引用，可点击查看片段原文
  - Agent：模型通过工具完成任务——知识库检索、获取时间、打开链接、保存笔记（Markdown/文本），执行过程以时间线实时展示
- **混合检索**：trigram FTS5（BM25 关键词路）+ HNSW 向量（语义路）经 RRF 融合与词法重排，中文型号/编号与近义表达都能召回
- **知识库管理**：导入 PDF / DOCX / Markdown / TXT，自动切分入库；支持文档片段预览、删除知识库、重建语义索引
- **会话管理**：历史会话列表、全文搜索消息、自动标题、流式输出
- **双路模型配置**：本地 Ollama（自动探测与模型列表）或云端 OpenAI 兼容接口（Base URL / API Key / 模型名可配），API Key 经 safeStorage 加密存放
- **备份与迁移**：设置备份（JSON）与全量数据备份（会话 + 知识库文本），换电脑可恢复
- **本地优先**：单文件 SQLite + 本地 HNSW 索引；无账号、无 telemetry

## 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | Electron 44 + electron-vite |
| 前端 | React 18 + TypeScript + Tailwind CSS 4 + Zustand |
| 存储 | better-sqlite3（会话/文档/FTS） |
| 向量 | hnswlib-node（HNSW 索引，文件存于 userData） |
| 文档解析 | pdfjs-dist、mammoth |
| 质量门 | tsc 双 tsconfig + node:test 冒烟套件 |

## 环境要求

- Node.js 22+（开发）/ npm
- [Ollama](https://ollama.com/)（仅使用本地模型时需要；云端 OpenAI 兼容接口可替代）
- macOS（Apple Silicon / Intel）或 Windows x64

## 开发

```bash
npm ci        # 安装依赖；postinstall 会把原生模块重编到 Electron ABI
npm run dev   # 启动开发环境（主/preload/渲染三端热更新）
```

其他常用命令：

```bash
npm run typecheck  # 主进程 + 渲染进程类型检查
npm test           # 冒烟测试（跑在 Electron 内置 Node 上，无需 Ollama/网络）
npm run build      # 构建三端产物到 out/
npm run dist:mac   # 打包 macOS dmg + zip 到 dist/
npm run dist:win   # 打包 Windows NSIS 安装包
```

> 原生模块（better-sqlite3、hnswlib-node）必须匹配 Electron 的 ABI。
> 如果升级了 Electron 或出现 `NODE_MODULE_VERSION` 不匹配，重跑
> `npx electron-builder install-app-deps` 即可。

## 目录结构

```
src/
├─ main/            # 主进程：IPC、SQLite、RAG/Agent 服务、密钥存储
│  ├─ db/           # schema.sql + 连接/迁移
│  ├─ ipc/          # IPC handler 注册（chat/kb/settings/data…）
│  └─ services/     # conversations / knowledge / rag / agent / llm
├─ preload/         # contextBridge 安全桥（window.api 的唯一暴露面）
├─ renderer/        # React 渲染层（组件 + Zustand stores）
└─ shared/          # 主/渲染共享的类型与流式协议
tests/              # node:test 冒烟套件（TS 直跑，零测试框架依赖）
docs/learning/      # 模块开发讲义 M0–M6（学习向实现笔记）
```

## 下载安装

正式产物在 [GitHub Releases](../../releases)：

- macOS：选择对应架构的 dmg（`arm64` = Apple Silicon M 系列，`x64` = Intel）
- Windows：`Setup-x64.exe`
- 所有安装包均**未做代码签名**（个人学习项目），首次打开的放行方式见下方 FAQ

## 发版流程

1. 修改 `package.json#version`
2. 提交并打标签：`git tag v0.x.y && git push origin v0.x.y`
3. [Release 工作流](.github/workflows/release.yml) 在三台 runner 上并行打包，产物自动挂到对应 GitHub Release（标签号必须与版本号一致）

日常推送到 `main` 会触发 [CI](.github/workflows/ci.yml)：类型检查 → 冒烟测试 → 三端构建（不打包）。

## 排障 FAQ

**macOS 提示"无法打开，因为无法验证开发者"？**
未签名 ad-hoc 包的正常提示。在 Finder 中右键应用 →「打开」→ 再次点「打开」即可；
或命令行执行 `xattr -dr com.apple.quarantine "/Applications/Lumen Desk.app"`。

**Windows 弹出 SmartScreen"Windows 已保护你的电脑"？**
点「更多信息」→「仍要运行」。这是未购买代码签名证书的软件的通用提示。

**提示 Ollama 不可用 / 连接失败？**
确认 Ollama 已启动（菜单栏有图标，或终端 `ollama serve`），
并已拉取模型：`ollama pull qwen2.5`（模型名可在设置中修改）。
不装 Ollama 也可以在设置中改用云端 OpenAI 兼容接口。

**应用数据在哪个目录？**
- macOS：`~/Library/Application Support/lumen-desk/`
- Windows：`%APPDATA%\lumen-desk\`

其中 `lumen.db` 是全部结构化数据，`vectors/` 是语义向量索引。
迁移机器建议使用设置内的「全部数据备份 / 导入数据」，不要直接拷库时漏掉向量文件。

**更换 embedding 模型后语义检索结果异常？**
不同 embedding 模型的向量维度/空间不兼容。更换模型后到知识库页对每个库点
「重建索引」即可（重建只影响向量索引，文档文本无需重新导入）。

**恢复全量备份后语义搜索不可用？**
备份文件为控制体积只含文本、不含向量，关键词搜索恢复后立即可用；
按导入成功提示在知识库页对相关库执行一次「重建索引」即可恢复语义检索。
API Key 同样不在备份中，需要重新填写。

**日志或界面报 `NODE_MODULE_VERSION` 不匹配？**
原生模块被装成了系统 Node 的 ABI。重跑
`npx electron-builder install-app-deps`，然后重启应用。

**外置 SSD 上首次启动有 sandbox 相关提示？**
macOS 对非标准位置未签名应用的提示，非致命；把应用拖到 `/Applications` 再打开即可。

## 文档

开发过程的学习讲义在 [docs/learning](docs/learning/README.md)：M0 Electron 骨架 →
M1 流式聊天 → M2 Ollama 本地模型 → M3 RAG 知识库 → M4 混合检索 → M5 Agent →
M6 交付打包。

## License

MIT
