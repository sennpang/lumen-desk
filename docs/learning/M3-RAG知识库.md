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

## 深入：向量、图索引与切分器的内部机制

### A. "语义坐标化"到底在说什么：用三维玩具模型理解 embedding 与 cosine

embedding 模型是一个函数：`文本 → 一串固定长度的实数`。真实模型是 768/1024 维，无法直观，用**假装只有 3 维**的玩具模型看本质。假设模型把词映射成：

```
猫     → [ 0.9,  0.1, -0.2]
小猫   → [ 0.88, 0.12, -0.18]   （和"猫"方向几乎一致）
汽车   → [ 0.1, -0.8,  0.3]    （完全不同的方向）
```

模型在海量语料上训练后，**"用法/含义相近的词，向量方向也相近"**——这就是语义的坐标化。衡量方向相近程度用 cosine 相似度（本项目 HNSW space 固定 `'cosine'`）：

```
                A·B                两个向量对应位相乘再求和（点积）
cos(A,B) = ─────────────
            |A| × |B|              各自长度（所有位平方和开根号）
```

值域 -1~1：1 = 方向完全相同，0 = 正交（无关），-1 = 相反。分母除以向量长度意味着**只看方向、不看长短**：一段话说了三遍"猫猫猫"，向量方向不变只是模变长，cosine 仍判为同主题；而"汽车"和"猫"的点积趋近 0。HNSW 返回的 `distance` 是 cosine 距离（≈ 1−相似度，越小越近），UI 里只用来排序不展示。

提问时发生的事：把用户的问题也 embedding 成一个 768 维向量 → 在图里找方向最接近的 6 个 chunk 向量 → 取回文本。全程没有一个字是关键词匹配，所以"怎么让咖啡甜一点"能命中不含"甜"字的资料。

### B. HNSW 在"图"上怎么找近邻：为什么它是"近似"的

精确解法是暴力扫描：查询向量与库里每个向量算一次 cosine，10 万个块就是 10 万次 768 维乘加——每次提问都这么算不可接受。HNSW（Hierarchical Navigable Small World）的思路是**提前在向量之间修一张分层高速公路网**：

- 每个向量是图上的一个节点，节点和它附近的若干节点之间有边；
- 图分多层：最上层边少而长（"省际高速"，节点稀疏），越往下边越多越短（"城市道路"，节点稠密）；
- 检索时从最高层的随机入口开始，每层贪心地走向离查询更近的邻居，走到该层局部最近后下沉一层；层层缩小范围，最底层做一次精细邻居扫描。

这类似地图导航找附近咖啡馆：先走高速快速逼近区域，再走街道精确定位，不需要挨家挨户扫街。代价是**近似**——极端情况下可能错过真正的最近邻，但实测召回率足够高，而速度从 O(n) 降到 O(log n) 级别。建索引时的 M（层数/连接数）由库默认参数决定，我们只消费检索结果。

### C. 检索函数逐行走读：向量怎么变回 chunk 文本

[vectorStore.ts](../../src/main/services/rag/vectorStore.ts) 的 `searchVectors` 只有四步，每步都对应一个具体约束：

```ts
const meta = await readMeta(kbId)                         // ① 读映射（不是读向量）
if (!meta || !existsSync(indexPath(kbId))) return []       //   空库静默返回 []
if (meta.dim !== vector.length) throw new Error('…请重建索引')  // ② 维度守卫

const index = new HierarchicalNSW(SPACE, meta.dim)
index.readIndexSync(indexPath(kbId))                      // ③ load 图到内存（无状态式 API）
const result = index.searchKnn(vector, Math.min(k, 元素数)) //   真正的近邻图搜索

result.neighbors.forEach((label, i) => {                  // ④ 整数 label → uuid
  const chunkId = meta.labels[label]
  if (chunkId) hits.push({ chunkId, distance: result.distances[i] })
})
```

注意第 ④ 步：图里存的、searchKnn 返回的都只是整数 label，**真正的文本在 SQLite 的 chunk 表**，要拿 `meta.labels[label]` 换回 uuid 再去 SQL 查。这就是"向量不入库、数据库不存向量、meta.json 是两者唯一桥梁"的实际形态。第 ② 步的维度错误是真实出现过的故障：用户换了 embedding 模型（768→1024 维），查询向量维度和图维度对不上，继续算只会得到垃圾结果，所以直接报错并把"下一步该做什么"（重建索引）写进错误文案。

### D. 写入与删除：label 分配、容量扩容、原子落盘

`appendVectors` 的关键几行：

```ts
let nextLabel = meta.nextLabel
for (const item of items) {
  const label = nextLabel++                  // 单调递增
  meta.labels[label] = item.chunkId
  index.addPoint(item.vector, label)        // label 是 C++ size_t，只能吃整数
}
meta.nextLabel = nextLabel                  // 已删除的 label 不复用
```

为什么 label 删除后留空洞也**绝不复用**：label 只是图节点的数字名字，复用旧 label 意味着"旧引用指向新向量"——如果有任何历史数据（日志、未来的快照）残留了旧 label，就会静默串到完全无关的新 chunk。单调递增让 label 永远唯一，零成本防这类 bug。容量不够时 `resizeIndex` 扩容（初始 1024，按 4 倍）；删除用 `markDelete(label)` 打墓碑（节点物理还在但不再参与检索），同时删 meta 里的映射键；**全删光时直接 unlink 两个文件**，让下次导入从全新索引开始，避免墓碑空洞无限累积。

落盘是"写临时文件 + rename"双原子写：

```ts
index.writeIndexSync(`${target}.tmp`); await rename(tmp, target)  // 索引
await writeFile(metaTmp, ...); await rename(metaTmp, meta)       // 映射
```

同卷 rename 在 POSIX/Windows 上都是原子的：崩溃要么发生在 rename 前（旧文件完好）、要么 rename 后（新文件完整），永远不会留下写了一半的损坏索引。代价是 load→改→save 的无状态用法（每次导入都重新读盘），对低频导入操作完全值得，还顺带消灭了并发锁。

### E. 切分器：标题栈与贪心打包（为什么不是简单按字数切）

[chunker.ts](../../src/main/services/rag/chunker.ts) 的输入是 parser 产出的块序列（heading / paragraph，paragraph 带 PDF 页码），两阶段处理。

**阶段 1：标题栈**把扁平的块流变成带"面包屑"的语义单元：

```ts
if (block.kind === 'heading') {
  while (栈顶.level >= block.level) 栈.pop()   // 同级标题替换、上级标题离开时弹栈
  栈.push({ level: block.level, text: block.text })
} else {
  units.push({ text: block.text, page: block.page,
              headingPath: 栈.map(h => h.text).join(' / ') })
}
```

走一遍 `# A`→段落→`## B`→段落：栈在 `## B` 时弹出同级的 `# A`，每个段落拿到当时的栈快照，如 `"冲煮指南 / 闷蒸"`。引用角标弹窗里的"文档名 / 章节路径 / 页码"出处就来自这里。

**阶段 2：贪心打包**——把段落单元往当前 chunk 里塞，三条封口规则：

1. **超预算封口**：`currentTokens + tokens > 500` 就 flush 另起；
2. **标题边界强制封口**：即使没超 500，下一段的 headingPath 变了也立刻封口——否则一个 chunk 跨两个小节，标题归属只能保留第一个，检索和引用都丢小节信息；
3. **单段超长走滑动窗口**：先 flush 已有内容，再把这一个段落按窗口切，回退 50 token 时优先找句读标点（`。！？!?；;`）落在句子边界，且强制 `start` 至少前进 1 字符防止无标点超长文本死循环。

重叠只在第 3 条（单段超长）发生：段落是天然语义边界，让相邻块重复整个正常段落只会让 topK 被重复内容占满，弊大于利。最后 `mergeTinyTail` 把不足预算 15% 的孤儿尾巴并进上一块（同标题前提下，宁可略超 500 也不要碎块）。

### F. trigram：中文关键词匹配为什么能用起来

M4 会细讲检索数学，这里先看存储层。chunk_fts 是一张 SQLite FTS5 虚拟表：

```sql
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  tokenize = 'trigram'
);
```

FTS5 是 SQLite 内置的全文索引引擎：写入文本时它按 tokenizer 切词，为每个词项维护**倒排索引**（词 → 出现它的 chunk 列表），查询时走索引而不是全表 LIKE 扫描。trigram 分词器把每个词切成连续三字符：`闷蒸咖啡`→`闷蒸咖`、`蒸咖啡`（及相邻三元组）。查询 `闷蒸咖` 同样切三元组去查倒排表，于是**中文不需要分词器**（unicode61 会把连续中文当成一个巨型 token，基本不可用）也能做子串匹配。`chunk_id UNINDEXED` 表示它只作为关联字段存着、不参与建索引（它是 uuid 不是文本）；库过滤通过 JOIN document 在查询时完成，不冗余 kb_id。

schema 注释里还有一条架构决策：FTS 同步**不用触发器**。因为 chunk 只有两个写路径——批量插入（导入）和随文档 CASCADE 删除——在仓储的同一事务里双写 chunk + chunk_fts 更直观可控，避免"改了 chunk 表却想不起 FTS 触发器为什么没触发"的隐式耦合。

### G. embedding 缓存：一次导入为什么大部分钱不用花

[embedder.ts](../../src/main/services/rag/embedder.ts) 的 `embedMany` 是三趟而不是直接批量请求：

1. **批内去重**：`hash = sha256(模型名 + '\0' + 文本)`，Set 去重——50 token 重叠窗口、跨文档重复段落，一个批次只算一次；
2. **读缓存**：每个唯一 hash 查 `embeddings-cache/{hash}.json`，命中直接取向量；
3. **只请求缺失项**：未命中的才发 HTTP（串行，本地模型更稳，单条 60s 超时照顾冷启动），请求回来立刻写缓存文件，最后按原始顺序回填。

key 里的 `模型名` 是安全开关（M3 自测题 4 已论证）；`\0` 分隔符防止模型名和文本拼出歧义。缓存写失败被静默吞掉——缓存只是优化不是数据源，磁盘满/权限问题不该让导入失败；但 404 不吞：Ollama 返回 404 意味着模型没 pull，错误文案直接给出 `ollama pull <model>` 命令。

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
7. 用玩具向量手算 cosine：猫 `[0.9,0.1,-0.2]`、小猫 `[0.88,0.12,-0.18]`、汽车 `[0.1,-0.8,0.3]`。分别算 cos(猫,小猫) 和 cos(猫,汽车)，并解释为什么把"猫"向量整体放大 3 倍后相似度几乎不变。
8. chunker 的贪心打包有三条封口规则（超预算 / 标题边界 / 单段超长）。说出每条规则"不封会怎样"，以及单段超长时滑动窗口为什么还要回退 50 token 且优先落在句读点。
9. FTS5 虚表为什么选 trigram 分词器而不是默认 unicode61？`chunk_id UNINDEXED` 是什么意思、为什么要这样设计？2 字中文查询在 SQL 层会发生什么？
10. appendVectors 分配 HNSW label 为什么单调递增、删除后留下的空洞也不复用？删文档时的 markDelete 和"全删光直接 unlink"分别解决什么问题？

## 自测题参考答案

**1. 画出从"用户拖入一个 PDF"到"回答里出现 `[1]` 角标"经过的全部模块与存储。**

分两个阶段。

导入（离线，`kb:import` 立即返回，后台串行）：

```
拖拽/选择文件
  → preload webUtils.getPathForFile 解析真实磁盘路径（浏览器 File 不给 path）
  → IPC knowledge.ts → indexing.importDocuments
      ├─ readFile + sha256：同库内容 hash 去重
      ├─ repo.insertDoc：document 行落 SQLite，status='parsing'，推 doc_enqueued
      ├─ parser.parseDocument：pdfjs（动态 import + worker）→ 带标题栈/页码的块
      ├─ chunker.chunkDocument：~500 token、50 重叠、标题归属 → RawChunk[]
      ├─ embedder.embedMany：/v1/embeddings 批量向量化，sha256(模型+文本) 文件缓存
      ├─ repo.insertChunks：一个事务里写 chunk 行 + chunk_fts（SQLite）
      ├─ vectorStore.appendVectors：整数 label↔uuid 写 vectors/{kbId}.index
      │                                （.tmp + rename 原子写）+ .meta.json
      └─ updateDocStatus('ready', n)：推 doc_result
存储：SQLite（document/chunk/chunk_fts）+ 文件（HNSW index + meta.json + embedding 缓存）
```

提问（在线，rag 分支）：

```
用户发送 → embedOne(问题) → vectorStore.searchKnn(topK=6, cosine)
  → 取回 chunk 原文 → retriever 编号 [1]…[6]、附文档名/页码注入 system 提示词
  → 检索完成即推 citation 事件（不等模型说完）+ citations 写 message.meta
  → streamChatCompletion（模型被要求只依据资料、结论后标序号）
  → token 流 → MessageBubble：正则 /\[(\d{1,2})\]/ 把序号渲染成角标
  → 点角标 → IPC kb:chunk 按 chunkId 懒加载 → 原文弹窗（文档名/页码）
```

**2. 切片为什么要重叠？如果把 overlap 设成 0，什么类型的问题最先出坏答案？**

一个论点/一句话可能正好落在切片边界上，被切成"前半句在块 A、后半句在块 B"。重叠（50 token）让边界两侧各带一份对方的上下文，无论检索命中哪一块，模型都能看到完整说法，降低"答案腰斩"。

overlap=0 时最先坏掉的是**答案依赖跨句完整陈述的问题**：比如手册里"错误码 E1045（第 47 页）表示传感器过热，请断电冷却 10 分钟"正好从"请断电"处切开——"E1045 是什么意思"只命中前块（有编号没处置办法），"过热怎么办"可能命中后块（有办法但不知道在说哪个错误码），两个块单独看都不完整。其次是带指代承接的问题（"该设备随后应……"里的"该设备"在上一块）。重叠不是越多越好：太大会让同一内容在多个 chunk 重复，挤占 topK 名额、抬高成本，500/50 是经验折中。

**3. HNSW label 为什么不能直接用 chunk uuid？`.meta.json` 里至少需要哪些字段？**

hnswlib-node 的 label 在 C++ 层是 `size_t`（无符号整数），API 只接受整数；uuid 是字符串，无法作为图节点的 label 存储。所以在"通用库约束"和"业务模型"之间加一层翻译（见 vectorStore.ts）：整数 label 单调分配，uuid ↔ label 映射存索引旁的元数据文件。至少需要：

- `dim`：向量维度（加载旧索引时校验与当前 embedding 模型是否一致，维度不符直接报错引导重建索引）；
- `space`：距离度量（项目固定 cosine/'l2' 语义）；
- `nextLabel`：下一个可分配的整数（单调递增，删除后留空洞但**不复用**——复用会让旧 label 的历史引用指向新向量）；
- `labels`：`{ [整数label]: chunkId }` 映射，检索拿到整数 label 后靠它换回 chunkId 去 SQLite 取原文。

删除时图上 `markDelete`（打墓碑，不再参与检索）+ 删映射键；全删光则连文件一起删掉重新开始，避免空洞无限累积。

**4. embedding 缓存的 key 为什么要包含模型名？只 hash 文本会怎样？**

向量是"**某个模型**对这段文本的坐标化"，不是文本的固有属性：

- 不同模型维度可能不同（nomic-embed-text 768 维、bge 可能 1024 维），把 A 模型的向量喂给按 B 模型建的 HNSW 索引会直接维度错误；
- 即使维度相同，不同模型的向量空间互不对齐——"语义相近距离就近"只在同一模型的坐标系内成立，混用等于把两张不同城市地图的坐标混着导航。

所以缓存 key = sha256(模型名 + 文本)。只 hash 文本时，用户切换 embedding 模型或重建索引会命中"文本相同但来自旧模型"的缓存，得到维度崩溃或看似能跑、结果完全乱掉的检索，而且这种错误不报错、极难排查。

**5. 模型在回答里写了一个不存在的 `[9]`，系统会怎样？这种防御为什么要在渲染层做？**

citation 列表只有检索回来的 6 段（编号 1–6）。MessageBubble 用正则 `/\[(\d{1,2})\]/` 匹配正文序号后，要拿编号去 citation 数组取对应来源：取不到（越界、或该序号根本不是引用语境）就**按普通文本渲染 `[9]`**，不生成角标；即使角标点下去，`kb:chunk` 在库里查不到也会返回 null，弹窗不打开。多层防御，任何一层都不相信模型输出。

为什么必须在渲染层（以及为什么源头也要防）：引用编号是模型自由生成的文本，模型会幻觉（资料只有 6 条却写 `[9]`、在没有引用的句子里乱标序号）。系统能控制的是"哪些来源真实存在"——citation 事实由检索端拼好下发，模型只能使用编号、不能创造来源。渲染端是"不可信文本 → UI 元素"的最后边界，把映射失败降级为纯文本，才能保证"界面上每个可点角标背后一定有真实片段"。

**6. 用户导入到一半强退，哪些机制保证不会留下半个索引/半个文档？**

按写入顺序看各层的保护（indexing.ts）：

1. **文档状态机**：document 行一落库就是 `parsing`，只有全部成功（chunks + 向量写完）才置 `ready`。检索/UI 以 ready 为准，中途的文档不会以"完成"的假象出现；失败走 `failed` 并带 error 文案。
2. **chunk 与 FTS 单事务**：`insertChunks` 在同一个 better-sqlite3 事务里写全部 chunk 行和 chunk_fts——崩溃则整体回滚，不会出现"文本在、FTS 没有"或反之的半批数据。
3. **向量索引原子写**：`appendVectors` 先写 `{kbId}.index.tmp` 再同卷 rename，rename 原子，崩在写图阶段正式索引保持上一版；meta.json 同样原子写。
4. **嵌入缓存天然可重入**：向量缓存按内容 hash 散在文件里，重导时已算过的片段直接命中，不重复花钱。
5. 强退后那张卡片会停在 `parsing`（当前版本不做启动重置，需要删掉该文档重导；因为 fileHash 已登记，重导同一文件会被内容去重跳过，所以要先删卡片）。最窄的不一致窗口是"索引/meta 已更新但 status 还没置 ready"——chunk 与向量实际已写入、检索 SQL 也不按 status 过滤，删掉该文档会级联清 chunk/FTS 并对索引 markDelete，仍可干净回收。

**7. 用玩具向量手算 cosine：猫 `[0.9,0.1,-0.2]`、小猫 `[0.88,0.12,-0.18]`、汽车 `[0.1,-0.8,0.3]`。分别算 cos(猫,小猫) 和 cos(猫,汽车)，并解释为什么把"猫"向量整体放大 3 倍后相似度几乎不变。**

cos = 点积 ÷（两向量模长之积）。

cos(猫, 小猫)：

```
点积 = 0.9×0.88 + 0.1×0.12 + (-0.2)×(-0.18) = 0.792 + 0.012 + 0.036 = 0.84
|猫|   = √(0.81+0.01+0.04) = √0.86 ≈ 0.927
|小猫| = √(0.7744+0.0144+0.0324) = √0.8212 ≈ 0.906
cos ≈ 0.84 / (0.927×0.906) ≈ 0.84/0.840 ≈ 0.9995
```

cos(猫, 汽车)：

```
点积 = 0.9×0.1 + 0.1×(-0.8) + (-0.2)×0.3 = 0.09 - 0.08 - 0.06 = -0.05
|汽车| = √(0.01+0.64+0.09) = √0.74 ≈ 0.860
cos ≈ -0.05 / (0.927×0.860) ≈ -0.063（几乎正交 = 无关）
```

一个 ≈1、一个≈0，语义远近被坐标方向量化出来。把"猫"整体放大 3 倍得 `[2.7,0.3,-0.6]`：点积变 3 倍（2.52），但它的模长也变 3 倍（≈2.782），分母里另一个模长不变，比值 `2.52/(2.782×0.906)` 仍是约 0.9995——分子分母同步放大被约掉。这就是"只看方向不看长短"：文档里把同一件事重复三遍，向量每个分量等比变大，方向不变，cosine 不会误判为"更相关"。HNSW 返回的 distance ≈1−cos，越小越近，只用于排序。

**8. chunker 的贪心打包有三条封口规则（超预算 / 标题边界 / 单段超长）。说出每条规则"不封会怎样"，以及单段超长时滑动窗口为什么还要回退 50 token 且优先落在句读点。**

三条规则对应三种坏块（[chunker.ts](../../src/main/services/rag/chunker.ts)，目标约 500 token）：

1. **超预算封口**：`currentTokens + 本段tokens > 500` 且当前块非空就先 flush。不封会产出上千 token 的巨块，超出 embedding 模型输入上限或被模型截断，检索时一个块混多个主题、命中后注入的资料噪声大。
2. **标题边界强制封口**：下一段的 headingPath 与当前块首段不同，即使没超 500 也立刻封。不封的话一个 chunk 跨两个小节，而 chunk 的 meta 只能挂一个 headingPath（保留首段的），后一小节的内容在引用卡片里显示错误归属，向量也把两个主题揉成一个方向。
3. **单段超长走滑动窗口**：先 flush 已积累内容，再把这一个段落按窗口切（强制 start 至少前进 1 字符防死循环）。不封的话规则 1 永远打不破（单段自己就 >500，无法靠段间边界封口）。

回退 50 token（DEFAULT_OVERLAP）是让相邻窗口共享一段重叠文本：答案的关键句若正好落在刀缝上，重叠保证它完整出现在至少一个块里，"把 A 和 B 连起来理解"的跨句问题不会因为切分而无解。优先落在句读标点（`。！？!?；;`）是因为刀落在句子中间会同时制造两个残句，语义完整度比硬按 token 数切更差；找不到合适标点才按 token 硬回退。overlap=0 时最先坏掉的就是这类跨边界事实拼接问题。

**9. FTS5 虚表为什么选 trigram 分词器而不是默认 unicode61？`chunk_id UNINDEXED` 是什么意思、为什么要这样设计？2 字中文查询在 SQL 层会发生什么？**

默认 unicode61 按字母/空格切 token，而中日韩文本词与词之间没有空格，"闷蒸咖啡"会被当成**一个**完整 token——搜"咖啡"匹配不到整词，等于关键词检索对中文作废。trigram 分词器把文本切成所有连续三字元组（"闷蒸咖""蒸咖啡"……）建倒排索引，天然支持无空格语言的子串匹配，且中英统一处理（`e1045` 也切成数字 trigram）。

`chunk_id UNINDEXED` 的意思是：这一列随虚表行存储（SELECT/JOIN 能取到），但**不建倒排索引、MATCH 检索不到它**。它只是挂在 FTS 行上的关联键，用来 JOIN 回 chunk 表拿 uuid；对它建索引纯属浪费空间，还可能让用户输入意外命中 id 字符串。schema 里同样刻意不冗余 kb_id——库过滤运行时 JOIN document 用硬合取完成，少一个必须与 chunk 表保持一致的冗余列。

2 字中文（如"闷蒸"）切不出任何长度 ≥3 的 gram，`buildQueryTerms` 在表达式构造前就返回 null，retriever 据此**整条跳过关键词路**（注意不是发出一个空 MATCH 去报错，也不是返回空结果），由向量路独挑；英文/数字也有门槛（正则要求 ≥3 字符）。

**10. appendVectors 分配 HNSW label 为什么单调递增、删除后留下的空洞也不复用？删文档时的 markDelete 和"全删光直接 unlink"分别解决什么问题？**

HNSW 的 label 是 C++ 层的 size_t 整数，图节点只认数字，chunk uuid 经 meta.json 的 `labels[label] = chunkId` 映射换入换出。label 由 `meta.nextLabel` 单调发放，**删除只从映射表删键、label 数字永不复用**：复用意味着"旧数字名字指向了新向量"，一旦日志、快照、未来任何同步链路里残留旧 label，就会静默串到完全无关的 chunk；单调递增零成本地保证 label 全局唯一。

删除策略分两档：

- **删部分文档**：`markDelete(label)` 在图里打墓碑——节点物理仍占空间，但不再参与 searchKnn 结果，同时删掉 meta 里的映射键（检索时还有一层 `if (chunkId)` 双保险）。不立刻物理删除是因为 HNSW 的图结构不支持廉价的节点摘除重连，墓碑是库提供的标准删除姿势；
- **删到全空**：直接 unlink 索引文件和 meta 文件，下次导入从全新索引开始。这解决了墓碑/扩容空洞无限累积的问题——一个库反复导入删除，若不重置，文件只胀不缩、图里全是死节点。

落盘统一"写 `.tmp` + 同卷 rename"：索引先写 `{kbId}.index.tmp` 再 rename 覆盖，meta.json 同样如此。POSIX/Windows 同卷 rename 都是原子的，崩溃只可能发生在 rename 前（旧文件完好）或 rename 后（新文件完整），不会留下写一半的损坏索引。容量不足时先 `resizeIndex(max(need, 当前容量×2))` 保证 addPoint 不越界。
