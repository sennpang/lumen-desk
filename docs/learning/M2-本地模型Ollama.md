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
