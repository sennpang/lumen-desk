# M3 · RAG 知识库

> 对应提交：`c5e507c` → `66cc387`（共 14 个）
> 目标：把 PDF/Word/Markdown 喂进去，回答时**只依据资料**、并给出可点击的出处引用。

RAG（Retrieval-Augmented Generation，检索增强生成）是这个项目的主干。这一阶段也是提交最多、链路最长的一章。

## 全链路鸟瞰

导入（离线，后台串行）：

```
文件路径
 │  parser      PDF/DOCX/MD/TXT → 带结构的文本块（标题栈/页码）
 │  chunker     结构保留切分：目标 500 token，相邻重叠 50 token
 │  embedder    文本 → 向量（带 hash 缓存，缺一个调一个）
 │  vectorStore 向量写 HNSW 文件，chunk 文本写 SQLite
 ▼
完成：document(status=ready, chunk_count) + chunk 表 + vectors/{kbId}.index
```

提问（在线）：

```
用户问题
 │  embedOne(query)                  问题也变成向量
 │  vectorStore.searchKnn(topK=6)    HNSW 近似最近邻，cosine
 │  retriever                        取回原文片段，拼 [1] [2]… 引用提示词
 │  streamChatCompletion             模型被要求"只依据资料，结尾标序号"
 ▼
回答 + citation 事件 → 渲染成角标；点击角标 kb:chunk 懒加载原文弹窗
```

## 关键代码导读（按数据流向读）

| 环节 | 文件 | 看点 |
|---|---|---|
| 解析 | [parser.ts](../../src/main/services/rag/parser.ts) | 四种格式归一为 `RawChunk[]`（标题栈 + 页码）；pdfjs 动态 import |
| 切分 | [chunker.ts](../../src/main/services/rag/chunker.ts) | 500/50 token、句读边界、防短尾、标题归属 |
| 嵌入 | [embedder.ts](../../src/main/services/rag/embedder.ts) | 调 `/v1/embeddings`；sha256(模型+文本) 文件缓存 |
| 向量库 | [vectorStore.ts](../../src/main/services/rag/vectorStore.ts) | HNSW 封装；**整数 label ↔ chunkId(uuid) 映射**；原子写 |
| 召回 | [retriever.ts](../../src/main/services/rag/retriever.ts) | topK 检索 + PRD 14.3 引用提示词模板 |
| 编排 | [indexing.ts](../../src/main/services/rag/indexing.ts) | 导入流水线、文件 hash 去重、重索引、删除 |
| 通道 | [ipc/knowledge.ts](../../src/main/ipc/knowledge.ts) + [ipc/dialog.ts](../../src/main/ipc/dialog.ts) | kb:* 频道、系统文件选择、kb:event 进度推送 |
| 接线 | [ipc/chat.ts](../../src/main/ipc/chat.ts) | rag 分支：先检索再注入，citation 随流推送 |
| 存储 | [knowledge/repo.ts](../../src/main/services/knowledge/repo.ts) | document/chunk 仓储 |
| UI | [KnowledgeView.tsx](../../src/renderer/app/components/KnowledgeView.tsx)、[MessageBubble.tsx](../../src/renderer/app/components/MessageBubble.tsx) | 拖拽导入、三态卡片、角标、来源弹窗 |

## 核心知识点

### 1. 为什么必须切片，不能把整篇文档塞进提示词

模型上下文窗口有限且贵。RAG 的核心假设是：**一个问题的答案通常只在少数几段里**。离线时把文档切成约 500 token 的片段并向量化；提问时只把最相关的 6 段（约 3000 token）塞进提示词，等于给模型一个"临时资料夹"。

### 2. 切片的两个工程细节

- **重叠（overlap 50 token）**：一句话/一个论点可能正好被切开，重叠保证边界两侧各有一份上下文，降低"答案腰斩"概率
- **结构保留**：切分维护标题栈，每个片段带着它所在的章节路径（`headingPath`）与 PDF 页码。这两个元数据后来在 M4 词法重排（标题命中加权）和 UI 引用展示（页码）里都用上了——切片时多存的结构信息是划算的投资

### 3. Embedding：语义的坐标化

embedding 模型（默认 `nomic-embed-text`，768 维）把任意文本映射成一个浮点向量，**语义相近的文本在向量空间里距离近**。"手冲咖啡水温"能匹配到写着"建议注水温度 92℃"的片段，靠的就是向量距离，而不是共同字面词。这正是 M4 要补一条关键词路的原因——语义路对型号、编号、罕见专名反而不敏感。

**缓存设计**：向量只取决于"模型 + 文本"，以二者的 sha256 为文件名缓存。同一段文字重复导入、重建索引时不再花钱/花时间调接口。批量嵌入时先查缓存，只对缺失项发请求。

### 4. HNSW 与"label 只能是整数"

hnswlib-node 是 HNSW（分层可导航小世界图）近似最近邻索引，毫秒级在十万向量里找最近邻。但它有一个硬约束：**向量的 label 是 C++ `size_t`，只能是整数**，而我们的 chunk id 是 uuid。

解决方式：向量文件旁边再放一个 `.meta.json`，维护 `nextLabel` 自增序号与 `{label: chunkId}` 映射。删除片段时 `markDelete`（图上打墓碑）+ 删映射键。这是"通用库约束向业务模型渗漏时，加一层翻译"的典型例子。

原子写：先写 `{kbId}.index.tmp` 再 `rename`，写到一半崩溃也不会留下半截损坏的正式索引。

### 5. 向量为什么不进 SQLite

SQLite 不擅长高维浮点向量的近邻检索（没有 ANN 索引，只能全表暴力算距离）。所以形成分工：**结构化数据（文档元信息、片段原文）在 SQLite，向量图在文件**，靠 chunk id 关联。

### 6. 引用的端到端闭环（最容易只做一半的功能）

1. 检索结果每段编号 `[1]…[6]`，附文档名/页码，注入 system 提示词并明确指令：只能依据资料作答、相关结论后标序号
2. 检索一完成就推 `citation` 事件（不用等模型说完），渲染端把来源卡挂到这条流式消息上
3. 引用同时写进 `message.meta`（JSON），正常/停止/出错三种收尾都要带上——否则刷新历史后引用消失
4. 渲染端用正则 `/\[(\d{1,2})\]/` 把正文序号渲染成角标，越界当纯文本；点角标调 `kb:chunk` 懒加载原文片段弹窗
5. 答案文本由模型生成、引用事实由系统拼接——**模型不能编造来源，它只能使用我们给的编号**

### 7. 后台任务要事件化，不能 invoke 死等

导入是秒级到分钟级任务（解析→逐个 embed→写索引）。`kb:import` 立即返回，主进程串行处理并推 `doc_enqueued / doc_result / import_finished`，渲染端增量更新卡片（含失败原因 `document.error`）。这条思路与 M1 的 chat:event 完全一致。

## 踩坑记录

- **pdfjs-dist 6 在 Electron 主进程加载**：它是 ESM 且自带 worker，必须动态 `import()` 且 worker 配置 externalize，静态 require 会炸。
- **hnswlib-node 3.x API 与旧教程全面不同**：`new HierarchicalNSW(space, dim)`（dim 在构造函数，不在 initIndex）、`writeIndexSync/readIndexSync`（旧的 save/load 已删）、`addPoint` 只吃普通数组不吃 Float32Array。M6 打包验证时这个坑又出现了一次。
- 拖拽文件拿路径：浏览器 File API 出于安全不给真实磁盘路径，Electron 里要用 preload 的 `webUtils.getPathForFile`。
- esbuild 打测试脚手架时该项目必须 `format: 'cjs'`（mammoth 内部 `require('url')` 与 ESM 冲突），因此不能 top-level await。

## 自测题

1. 画出从"用户拖入一个 PDF"到"回答里出现 `[1]` 角标"经过的全部模块与存储。
2. 切片为什么要重叠？如果把 overlap 设成 0，什么类型的问题最先出坏答案？
3. HNSW label 为什么不能直接用 chunk uuid？`.meta.json` 里至少需要哪些字段？
4. embedding 缓存的 key 为什么要包含模型名？只 hash 文本会怎样？
5. 模型在回答里写了一个不存在的 `[9]`，系统会怎样？这种防御为什么要在渲染层做？
6. 用户导入到一半强退，哪些机制保证不会留下半个索引/半个文档？
