# M5 · Agent 智能体

> 对应提交：`aff30df` → `3f1b6c7`（共 7 个，严格按"协议→存储→模型→工具→循环→IPC→UI"顺序）
> 目标：模型自己决定调不调工具、调哪个、调几轮；有副作用的动作必须先问人。

## Agent 和 RAG 的本质区别

这是理解整个里程碑的钥匙：

| | RAG（M3） | Agent（M5） |
|---|---|---|
| 谁决定检索 | 代码（用户选了 RAG 模式就检索一次） | **模型**（根据问题自己判断，可多次） |
| 轮次 | 单轮生成 | 多轮 ReAct 闭环，最多 6 轮工具 |
| 工具 | 只有内部检索 | 检索 / 时间（自动）+ 开链接 / 存文件（需批准） |
| 过程可见性 | 只看到引用 | 💭思考 → 🔧工具调用 → ↳观察 完整时间线 |

## ReAct 循环时序

```
messages = [system(Agent 规则), history…, user]
loop（toolRounds < 6）:
  resp = 模型(messages, tools = 本轮还允许则传 TOOL_SCHEMAS)
    │
    ├─ resp 没有 tool_calls → 这就是最终回答，结束
    └─ resp 有 tool_calls：
        · content（若有）→ thought 步骤（缓冲，不进聊天气泡）
        for 每个 toolCall:
           解析 arguments JSON  ──失败──▶ observation「参数 JSON 错误…」让模型自纠
           未知工具名          ───────▶ observation「未知工具…」
           requiresConfirm?
             是 → 推 confirm_required 事件，Promise 挂起等用户
                  批准 → execute()；拒绝 → observation「用户已拒绝」，不执行
             否 → 直接 execute()
           任何异常都捕获 → observation（execute 永不抛穿，4000 字截断）
        · assistant 消息(带 tool_calls) + tool 结果消息严格成对追加
        · 继续 loop
到第 6 轮仍在调工具 → 摘掉 tools 再请求一次，强制基于已有观察收尾
```

协议铁律：OpenAI 要求每个 assistant `tool_calls` 后面必须有角色为 `tool`、带对应 `tool_call_id` 的结果消息，**严格成对**，缺一个下一轮请求直接 400。

## 四件工具与风险分级

| 工具 | 能力 | 风险等级 | 实现要点 |
|---|---|---|---|
| `search_knowledge_base` | 复用 M4 混合检索 | 只读，自动执行 | top_k 夹在 1–10；片段各截 600 字 |
| `get_current_datetime` | 当前时间 | 只读，自动执行 | 解决模型"不知道今天几号" |
| `open_url` | 系统浏览器打开链接 | **副作用，需确认** | 协议白名单 `^https?://` + `shell.openExternal` |
| `save_note` | 保存笔记到磁盘 | **副作用，需确认** | `showSaveDialog`；basename 清洗 `[/\\]→_`；用户取消当正常观察 |

设计原则：**默认能力最小化，风险随能力升级**。工具定义统一为 `{schema, requiresConfirm, preview, execute}`，`execute` 返回 `{ok, output}` 且永不抛出——工具是模型的"外部世界"，外部世界的失败要变成模型能读到的文字，而不是炸掉整个循环。

## 关键代码导读（按 7 步提交顺序读）

1. [shared/types.ts](../../src/shared/types.ts) + [protocol.ts](../../src/shared/protocol.ts)：`ToolCall`（arguments 保留**原始 JSON 字符串**）、`ChatMessage.toolCalls`、`AgentStepInfo`、`agent_step`/`confirm_required` 事件——**先定契约**
2. [agent/repo.ts](../../src/main/services/agent/repo.ts)：步骤落库；`agent_step` 表补 `seq/confirm_id/confirm_status`（M1 预建表，M5 幂等 ALTER）；conv:get 批量回填
3. [llm/client.ts](../../src/main/services/llm/client.ts)：`tools` + `tool_choice:'auto'`；**SSE tool_calls 按 index 分片归并**（见下）
4. [agent/tools.ts](../../src/main/services/agent/tools.ts)：四件工具
5. [agent/runner.ts](../../src/main/services/agent/runner.ts)：ReAct 循环（本里程碑核心）
6. [ipc/chat.ts](../../src/main/ipc/chat.ts)：agent 分支、`pendingConfirms` Map、`chat:confirm-resolve`
7. 渲染：[Composer.tsx](../../src/renderer/app/components/Composer.tsx) 三态分段、[MessageBubble.tsx](../../src/renderer/app/components/MessageBubble.tsx) 时间线与确认卡、[useChat.ts](../../src/renderer/app/stores/useChat.ts)

## 核心知识点

### 1. 流式 tool_calls 是分片到达的，必须按 index 归并

模型吐工具调用和吐正文一样是流式的，但结构是数组增量：

```
第 1 片：choices[0].delta.tool_calls = [{index:0, id:'call_1', function:{name:'open_url'}}]
第 2 片：[{index:0, function:{arguments:'{"url'}}]
第 3 片：[{index:0, function:{arguments:':"https://…"} }]
……
```

`id/name` 只在首片，`arguments` 是逐字符拼接的 JSON 字符串。用 `Map<index, 累加器>` 归并，结束后才能 `JSON.parse(arguments)`。用数组下标或"取最后一片"都会在多工具/分片边界翻车。

### 2. 错误转观察，而不是短路或吞掉

参数 JSON 坏了、工具名不存在、工具执行抛异常——统一处理成一段 observation 文本喂回模型（"参数不是合法 JSON：…"）。小模型常产出半截 JSON，给它报错原文它往往能在下一轮自纠。这比"静默忽略"（模型永远等不到结果）和"直接终止"（一次小错毁掉整轮）都健壮。对应经验：JSON 解析失败不能静默短路。

### 3. 审批是一个挂起的 Promise——它不在 fetch 上

```ts
const approved = await new Promise<boolean>(resolve => {
  pendingConfirms.set(confirmId, { resolve, streamId })
})
```

模型循环在 `await` 处自然停住，UI 收到 `confirm_required` 渲染允许/拒绝卡片，用户点击后 IPC `chat:confirm-resolve` 找到 resolver 放行。

最容易漏的资源泄漏点：**这个 Promise 不在 HTTP 请求上，AbortController 碰不到它**。所以 `chat:stop` 的正确顺序是——先把所有挂起审批 `resolve(false)`，再 abort 模型请求；否则用户停止后那个 Promise 永挂，Map 泄漏。

### 4. 中间过程为什么只存 agent_step，不进 message 表

tool 角色消息是喂给模型的对话协议构件，不是给用户看的聊天记录。设计上：`message` 表只存用户消息与 assistant 最终文本；思考/工具调用/观察全部写 `agent_step`（挂在 assistant 消息 id 下，带 seq）。历史会话还原时用这些步骤重建时间线，包括审批徽标的最终状态（approved/denied）。

### 5. 小模型的真实能力边界

实测 qwen2.5:**0.5b** 在 temp=0 下工具触发率约 2/3——简单单工具够用，多步推理不稳。工程应对：系统提示词明确规则、端到端测试对"期望工具出现"做重试。产品建议：复杂多步 Agent 用 7B（`ollama pull qwen2.5:7b`）。选型要实测，不能假设任何模型都稳定支持 tools。

## 踩坑记录

- 测试等待审批时，谓词不能把"已处理的 confirm_required"当未决事件，否则提前 break 漏掉后续 observation；同一个 stepId 的 waiting→approved 是两条事件，断言状态要取最后一条
- 0.5b 工具轮的 content 经常为空，因此不产生 thought 步骤——这是模型行为不是 bug，测试不能强断言 thought 落库
- 生成器的 return 值用 `for await` 取不到，必须 `while(true){ const n = await gen.next(); if(n.done) 用 n.value }`

## 自测题

1. 不看代码画出 ReAct 一轮里 messages 数组的追加顺序，并解释"成对"为什么是协议硬要求。
2. 模型把 arguments 分片吐成了 `{"url":"htt` + `p://x"}`，代码在哪一层、用什么数据结构拼回完整 JSON？
3. 用户点"拒绝"后，循环里发生了什么？模型为什么不会反复重试同一个危险操作？
4. 为什么 `chat:stop` 要先 resolve 挂起审批再 abort？少这一步会泄漏什么？
5. 一个工具执行时抛了未预期异常，用户在界面上会看到什么？为什么看不到红色崩溃？
6. 为什么不把 tool 角色消息也存进 message 表？
