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
