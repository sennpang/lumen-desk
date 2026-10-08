# M2 · 本地模型 Ollama

> 对应提交：`ed6a1fd` → `852c96f`（共 7 个）
> 目标：同一套聊天代码，既接云端 DeepSeek，也接本机 Ollama，全程可离线。

## 解决什么问题

M1 把云端聊天跑通了，但 local-first 是产品的核心承诺：数据不出本机、断网可用、不花 token。M2 要解决：

1. 怎么发现用户机器上装没装 Ollama、有哪些模型
2. 怎么让 M1 的客户端**一行不改**就能打本地模型
3. 没装/没模型时，UI 怎么引导而不是报错了事

## 架构：provider 归一化模式

M2 最值得学的不是 Ollama 本身，而是**"多供应商，一个出口"的收口方式**：

```
AppSettings (provider: 'cloud' | 'local')
        │
        ▼
resolveModelConfig(settings, cloudApiKey)
        │ 成功 → { baseUrl, apiKey, model }   ← 统一形态
        │ 失败 → { ok:false, message }        ← 用户能看懂的配置指引
        ▼
streamChatCompletion({baseUrl, apiKey, model, …})
        │
        ├─ cloud: https://api.deepseek.com/v1/chat/completions
        └─ local: http://127.0.0.1:11434/v1/chat/completions
```

`client.ts` 完全不知道 provider 概念的存在。将来接第三家（智谱、OpenRouter、本地 LM Studio），只改 resolver 和设置表单，聊天链路零改动。

## 关键代码导读

- [src/main/services/llm/resolve.ts](../../src/main/services/llm/resolve.ts)：归一化的核心。注意 `apiKey: 'ollama'` 占位串——Ollama 不校验授权，但 OpenAI 协议要求 Authorization 头存在
- [src/main/services/llm/ollama.ts](../../src/main/services/llm/ollama.ts)：发现服务。请求 Ollama 原生 API `/api/version`、`/api/tags` 做探活与模型列表；任何失败都返回 `{available:false, reason}` 而不是抛异常
- [src/main/ipc/ollama.ts](../../src/main/ipc/ollama.ts)：`ollama:status` / `ollama:models` 两个只读频道
- [src/main/ipc/settings.ts](../../src/main/ipc/settings.ts)：`settings:test` 分本地/云端两个分支——本地先探活、再查是否选了模型
- [src/renderer/app/components/SettingsModal.tsx](../../src/renderer/app/components/SettingsModal.tsx) 里的 `OllamaSection`：三态 UI（检测中 / 可用列模型 / 不可用给安装步骤）

## 核心知识点

### 1. Ollama 的 OpenAI 兼容层

Ollama 除了自家的 `/api/chat`、`/api/generate`，还提供 `/v1/chat/completions` 和 `/v1/embeddings`，报文格式就是 OpenAI 的。这是整个归一化能成立的物理基础——本地模型在协议层"伪装"成一个 OpenAI 端点。

实测差异（都在代码里做了兼容）：

- SSE 行为一致，逐 chunk `data:` 帧
- `usage` 帧的 `choices` 可能是空数组（M1 解析时就已按防御式处理）
- 模型列表在原生接口 `/api/tags`，字段是 `details.parameter_size`、`details.quantization_level`（OpenAI 没有对应物，所以发现服务用原生 API、对话用兼容 API，各取所长）

### 2. 探活为什么不抛异常

UI 需要区分"没装"、"没启动"、"启动了但没模型"三种状态来给不同引导。如果发现服务直接 throw，渲染端只能显示一条干巴巴的错误。返回结构化结果（`available + reason + version`）让 IPC 永远是正常返回，**把"环境缺失"建模成一种正常状态，而不是异常**——这是面向用户的软件和面向程序员的库之间的重要区别。

### 3. 127.0.0.1 而不是 localhost

默认地址写 `http://127.0.0.1:11434`。`localhost` 可能先解析到 IPv6 的 `::1`，而 Ollama 默认监听 IPv4，偶发连不上。IP 字面量跳过 DNS 与地址选择差异，断网也可达。

### 4. 对话模型与 Embedding 模型是两个独立选择

`resolve.ts` 里有两个 resolver：对话用什么模型、向量化用什么模型互不绑定。用户可以用云端 7B 对话 + 本地 nomic-embed-text 做嵌入（M3 起大量用到），这是成本/隐私/质量的自由组合。

## 深入：归一化防腐层与本地 HTTP 实况

### A. resolver 不是"配置表"，是一道防腐层（ACL）

先看它的真实形状（[resolve.ts](../../src/main/services/llm/resolve.ts)）：

```ts
export type ResolveResult =
  | { ok: true; config: ResolvedModelConfig }
  | { ok: false; message: string }

export function resolveModelConfig(settings, cloudApiKey): ResolveResult {
  if (settings.provider === 'local') {
    if (!settings.ollamaModel.trim())
      return { ok: false, message: '尚未选择本地模型，请在「设置」中检测 Ollama 并选择…' }
    return { ok: true, config: { baseUrl: settings.ollamaUrl, apiKey: 'ollama', model: … } }
  }
  // cloud 分支：先查密钥、再查模型名，各自给人话错误
  …
}
```

它在架构里的位置是一道**防腐层（Anti-Corruption Layer）**：左边是"设置界面长什么样、provider 有几家、密钥存哪个文件"这些易变的世界，右边是 client.ts 那个极简稳定的世界（只认识 `{baseUrl, apiKey, model}`）。所有"世界差异"都在这一个函数里被翻译成统一形态或一句可展示的中文错误，不允许渗漏到右边。

消费方（chat.ts executeRun 开头）的写法因此非常干净：

```ts
const resolved = resolveModelConfig(settings, cloudApiKey)
if (!resolved.ok) {
  emit(target, { type: 'error', streamId, message: resolved.message })
  return                       // 配置缺失=用户可自行修复的问题，不是异常堆栈
}
const { baseUrl, apiKey, model } = resolved.config   // 之后的代码再也没有 provider 分支
```

注意错误也走**结构化返回而不是 throw**：没配 Key、没选模型都不是程序故障，是用户下一步操作的指引，经 error 事件显示成正常文案。这与发现服务"环境缺失不是异常"是同一条设计哲学。

### B. 一次本地对话在 HTTP 层到底长什么样

把代码翻译成 curl，能彻底消除"Ollama 是不是特殊协议"的疑惑。点击"检测"时主进程发出（回环地址，不出网卡）：

```bash
# 探活：原生管理接口
curl http://127.0.0.1:11434/api/version
# → {"version":"0.5.7"}

# 列模型：原生管理接口
curl http://127.0.0.1:11434/api/tags
# → {"models":[{"name":"qwen2.5:7b","size":4700000000,
#              "details":{"parameter_size":"7.7B","quantization_level":"Q4_0"}}]}
```

真正发消息时，走的是**兼容接口**，报文和打云端完全同构：

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ollama' \
  -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"你好"}],"stream":true}'
# → data: {"choices":[{"delta":{"content":"你"}}]}
# → data: {"choices":[{"delta":{"content":"好"}}]} … data: [DONE]
```

Ollama 服务端内部做的事是：把这套 OpenAI 报文翻译成自己的执行引擎（模型权重经 llama.cpp/ggml 推理），再把推理输出重新包装成 OpenAI 形态的 SSE。**翻译发生在 Ollama 进程内，我们的应用零感知**——这就是"协议标准化"的杠杆：一个客户端实现，n 个提供方各自做适配。

### C. 探活的三种失败，在 fetch 里长什么样

"没装/没启动/出错"听起来像产品话术，落到 Node fetch 是三个不同的底层结果，[ollama.ts](../../src/main/services/llm/ollama.ts) 用一次 try/catch 把它们全部收编：

```ts
async function getJson(url: string, timeoutMs: number) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Ollama 返回 ${res.status}`)
  return res.json()
}
```

- **没装/没启动（端口无人监听）**：TCP 连接直接被拒，fetch 抛 `fetch failed`，cause 是 ECONNREFUSED；
- **装了但卡住/端口被占/防火墙丢包**：TCP 没有响应，`AbortSignal.timeout(1500)` 在 1.5 秒后让 fetch 以 TimeoutError 失败——探活超时故意设得很短（1500ms），因为这是用户点一下按钮就盯着看的同步交互，快速失败比准确等待重要；
- **服务活着但响应异常**：连上了但 HTTP 状态非 2xx，代码显式 throw 带状态码。

`detectOllama` 对以上全部 catch，返回 `{available:false, reason}`——**永不抛异常是探活函数的契约**。而 `listOllamaModels` 恰恰相反，它不 catch、失败直接抛：因为它只在"已经探活成功、用户明确点刷新"时被调用，此时失败才是真正的意外，让 IPC 把 reject 带回 UI 显示具体原因最省事。**同一个文件里两种错误策略，区别不在技术，在调用场景**。

### D. 为什么默认值必须是 127.0.0.1 而不是 localhost

`localhost` 是个主机名，要先做 DNS 解析，而它通常同时有两条记录：IPv4 的 `127.0.0.1` 和 IPv6 的 `::1`。Node/net 层按系统地址选择策略可能**先试 `::1`**；Ollama 默认只绑定 IPv4 回环，于是连接 `::1:11434` 被拒，部分系统不会自动回退到 IPv4（或回退很慢），表现为"明明服务起着却连不上"。写死 IP 字面量同时消灭了 DNS 解析耗时、IPv4/IPv6 选择差异，并且回环地址不经过物理网卡——断网、飞行模式下照样可达，这是本地推理的核心承诺。

### E. 两个 resolver = 两种模型生命周期独立

对话模型与 embedding 模型在 [resolve.ts](../../src/main/services/llm/resolve.ts) 里是 `resolveModelConfig` / `resolveEmbeddingConfig` 两个独立函数，共用网关地址和 Key 但模型名各自校验。为什么必须独立：

- 用途完全不同：对话模型要"会说"，embedding 模型要"会把文本映射到固定维度向量空间"，厂商的模型谱系里这就是两类 SKU（DeepSeek 甚至根本不提供 embedding 接口）；
- M3 的索引绑定 embedding 模型（向量维度写在 .meta.json），换对话模型不影响已建索引，换 embedding 模型才需要重建；
- 自由组合：云端强对话模型 + 本地隐私 embedding，或反过来。

两个函数返回同一个 `ResolvedModelConfig` 类型，所以 client（对话）和 embedder（向量化）仍是同一套 HTTP 机制——归一化在两个维度上各做一次。

## 踩坑记录

- 直接拿 M1 的 SSE 解析打 Ollama 基本能通，但"最后一帧 choices 为空"如果按 `choices[0].delta` 裸取会偶发崩——防御式数组访问在 M1 就该写好，M2 是检验。
- 模型列表字段名靠想当然会写错（`quantization` vs `quantization_level`），这类东西只能 curl 一次 `/api/tags` 看真实报文。

## 自测题

1. 为什么加 Ollama 支持时 `client.ts` 几乎不用改？这依赖 Ollama 的什么能力？
2. `apiKey: 'ollama'` 这个占位串能不能省？为什么？
3. 发现服务为什么返回结构化状态而不是直接抛错？列出至少三种要区分的用户状态。
4. 如果让你再接一家"OpenAI 兼容但报文有细微差异"的供应商，你会改哪几个文件？哪个文件坚决不该动？

## 自测题参考答案

**1. 为什么加 Ollama 支持时 `client.ts` 几乎不用改？这依赖 Ollama 的什么能力？**

依赖 Ollama 提供了 **OpenAI 兼容端点**：除了自家原生的 `/api/chat`、`/api/generate`，Ollama 还暴露 `/v1/chat/completions` 和 `/v1/embeddings`，请求/响应报文就是 OpenAI 那套（messages 数组、SSE 的 `data:` 帧、`choices[0].delta.content`）。

所以本地模型在协议层"伪装"成一个 OpenAI 服务，M1 手写的客户端只认 `{baseUrl, apiKey, model}` 这个统一形态，根本不知道"provider"概念存在。接入 Ollama 时改动只发生在 resolver（把 baseUrl 指到 `http://127.0.0.1:11434/v1`）和发现服务（用 Ollama 原生 API 探活/列模型）。M1 里写的防御式访问（最后一帧 `choices` 为空数组、usage 单独出现）在 Ollama 身上刚好被再次验证——兼容是大体兼容，边界差异仍要按防御式处理。

**2. `apiKey: 'ollama'` 这个占位串能不能省？为什么？**

不能（在当前客户端实现下）。Ollama 本身不校验授权，随便给什么都行，但 M1 的 `client.ts` 对所有端点走同一条 OpenAI 协议路径：无条件附带 `Authorization: Bearer <apiKey>` 请求头。如果本地路径给空串/undefined：

- 要么客户端要分叉出"本地不发 Authorization、云端发"的逻辑，归一化被打破；
- 要么发出 `Authorization: Bearer undefined` / `Bearer ` 这种畸形头，部分代理、本地中间件或将来换成需要鉴权的本地推理服务（LiteLLM、内网网关）会直接拒掉。

给一个非空占位串（`'ollama'`），协议形状完整、两条路径零分叉、对 Ollama 无副作用。它不是真正的密钥，只是"协议要求这个头存在"的填充物。

**3. 发现服务为什么返回结构化状态而不是直接抛错？列出至少三种要区分的用户状态。**

因为"环境缺失"对这类产品是**正常状态而不是异常**，UI 必须根据不同状态给出不同的下一步引导，而不是一条干巴巴的错误文案。发现服务（ollama.ts）把探活/列模型的失败全部归一为 `{ available, reason, version? }` 正常返回，至少区分：

1. **没安装**：11434 连接被拒/超时且本机找不到服务 → UI 给下载链接和安装三步引导；
2. **已安装但没启动**：探测到过安装痕迹但当前端口无响应（或直接连接失败）→ 提示 `ollama serve` / 从菜单栏启动；
3. **已启动但没有模型**：`/api/version` 通了但 `/api/tags` 列表为空 → 引导执行 `ollama pull qwen2.5`；
4. （第四态）**就绪**：版本号 + 模型列表都拿到了，下拉框列出可选模型及量化信息。

如果直接 throw，这四种情况在渲染端只会塌缩成一个 reject，丢失引导所需的全部信息；而且 IPC 抛错会让"检查环境"这种只读操作看起来像程序故障。

**4. 如果让你再接一家"OpenAI 兼容但报文有细微差异"的供应商，你会改哪几个文件？哪个文件坚决不该动？**

改：

- [resolve.ts](../../src/main/services/llm/resolve.ts)：provider 联合类型加成员（如 `'zhipu'`），补它的 baseUrl 默认值、模型名解析、需要的话鉴权方式；
- 设置相关：[shared/types.ts](../../src/shared/types.ts) 的 provider 枚举、设置表单 UI（厂商选择、Base URL、模型输入项）；
- 如果它的"环境发现"需要特殊探活（像 Ollama 那样），再加一个发现模块和只读 IPC 频道；
- 如果差异在 SSE 报文边界（比如字段名、帧格式不同），在 client.ts 的解析处加**最小兼容分支**，但优先判断是不是能通过防御式访问吸收掉。

坚决不该动的是**聊天主链路的协议形态**：`{baseUrl, apiKey, model}` 归一化出口、IPC `chat:run`、渲染端 useChat——一旦让 provider 概念渗漏到这些层，每接一家都要全链路改一遍，归一化模式就白做了。client.ts 的理想状态是"不知道任何供应商名字"。
