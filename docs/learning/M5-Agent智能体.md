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

## 深入：ReAct 循环、审批挂起与乐观流式的代码机制

### A. 主循环就是一个 while(true)：messages 数组在两轮中的完整演化

[runner.ts](../../src/main/services/agent/runner.ts) 的 `runAgent` 骨架极简：

```ts
const messages = [ system(Agent规则), ...history, user(本轮问题) ]
while (true) {
  const toolsAvailable = toolRounds < 6 ? TOOL_SCHEMAS : undefined   // 轮数保险
  const turn = await callModel(messages, deps, toolsAvailable)
  if (turn.toolCalls.length === 0 || toolsAvailable === undefined) {
    return { content: turn.content, ... }        // 无工具调用 = 最终回答，循环出口
  }
  messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })
  for (const call of turn.toolCalls) {
    const observation = await 执行或拒绝(call)  // 含审批挂起
    messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: observation })
  }
}
```

用"帮我把现在的时间存成笔记"走一遍，messages 的形态变化：

```
初始：[system, ...history, user "帮我把现在的时间存成笔记"]
第 1 轮模型返回 toolCalls=[get_current_datetime]
  push assistant {content:"", tool_calls:[{id:c1, name:get_current_datetime}]}
  push tool      {tool_call_id:c1, content:"2026-10-08 14:03:12"}
第 2 轮模型看到时间，返回 toolCalls=[save_note]（需审批）
  push assistant {content:"我先查到时间…", tool_calls:[{id:c2, name:save_note, args:{content:"…"}}]}
  （用户点批准）push tool {tool_call_id:c2, content:"✅ 已保存到 …"}
第 3 轮模型无 toolCalls，content="已保存：2026-10-08 14:03:12" → return，循环结束
```

**循环退出的唯一条件是"模型这一轮没再调工具"**——决定何时信息足够的是模型，不是代码。代码要做的是兜底：`MAX_TOOL_ROUNDS=6` 到顶后 `toolsAvailable=undefined`，请求里干脆不带 tools 字段，模型物理上无法再发起工具调用（协议里没有工具声明就不能产生 tool_calls，即使它无视系统提示硬吐了，代码也丢弃并强制收尾）；同时注入一条 user 角色的系统提示"别再调工具，直接回答"。双保险：声明层 + 提示词层。

### B. runner 怎么消费分片：为什么 callModel 不能用 for await

M1 讲过生成器 yield 的是增量、return 的是总结算（含 toolCalls）。runner 两边都要：**过程中**要把每片 delta 推给气泡（乐观流式），**结束时**要拿完整 content 与归并好的 toolCalls。所以 `callModel` 必须手写 `gen.next()` 循环：

```ts
const gen = streamChatCompletion({...})
let buffered = ''
while (true) {
  const { value, done } = await gen.next()
  if (done) return { content: value.content || buffered, toolCalls: value.toolCalls, ... }
  buffered += value
  deps.onAnswerDelta?.(value)      // 过程中：逐片推送
}
```

`for await` 只能迭代 yield 的值，生成器的 return 值会被丢掉——这是踩坑记录里那条。client.ts 内部已用 `Map<index, 累加器>` 把 SSE 工具分片归并成完整 ToolCall（id/name 首片到达，arguments 逐字符拼接，流结束才 JSON.parse），runner 看到的 `turn.toolCalls` 已经是归并、解析后的成品，分层职责清晰：**client 管协议分片，runner 管业务循环**。

### C. 乐观流式 + 回滚：为什么要"先推了再说"

Agent 轮有个两难：模型在一轮里**同时**输出思考文本和工具调用，但 SSE 先到的是 content 分片，工具调用在这一轮的最后才出现。如果等整轮结束再显示文本，长回答前会有几十秒沉默；直接把 content 当答案推进气泡，万一这轮带了工具调用，这些字其实是"思考独白"不是最终答案。

方案是乐观更新 + 一次回滚：

```
callModel 中每片 content → onAnswerDelta → chat.ts 累积进气泡（用户看到字在滚）
整轮结束发现有 toolCalls：
  → onAnswerReset()：清空气泡里本轮文本（chat 累积 answer 清零，推 agent_answer_reset）
  → 同一段文本以 thought 步骤（recordStep）挂进 agent_step 时间线折叠区
最终轮（无 toolCalls）的 content：不 reset，留在气泡 = 最终答案
```

用户看到的效果：文字先在气泡里出现，模型决定调工具时文字"移入"💭思考折叠区，气泡清空等最终答案。文本从未丢失（同一份 buffered 落两处之一），只是最终归属由"这轮有没有工具调用"在轮末决定。这比"给工具轮单独走非流式请求"体验好得多——思考过程也可见。

### D. 审批：一个 Promise 怎么把循环"冻"在半路，又怎么被另一扇门唤醒

runner 在执行副作用工具前的代码：

```ts
if (tool.requiresConfirm) {
  const confirmId = randomUUID()
  updateStepConfirm(callStep.id, { confirmId, confirmStatus: 'waiting' })
  deps.onStep?.(...waiting)                          // 渲染端弹确认卡片
  approved = await deps.onConfirm?.({ confirmId, stepId, toolName, args, preview })
  updateStepConfirm(callStep.id, { confirmStatus: approved ? 'approved' : 'denied' })
}
if (!approved) observation = '用户拒绝了该操作。不要重试……'
else { const r = await tool.execute(args, toolCtx); observation = r.output }
```

关键：`await deps.onConfirm(...)` 不是 await 网络，而是 await 一个**存储在 Map 里的、由另一个 IPC 调用来 resolve 的 Promise**。看 chat.ts 的配对代码：

```ts
// 发起审批时（runner 的 onConfirm 回调）：造一个 Promise，把 resolve 存进 Map
pendingConfirms.set(confirmId, { resolve, streamId })

// 用户点按钮时（另一扇门！）：
ipcMain.handle('chat:confirm-resolve', (_e, { confirmId, approved }) => {
  const pending = pendingConfirms.get(confirmId)
  if (!pending) return                    // 已随停止清理/重复点击：幂等忽略
  pendingConfirms.delete(confirmId)
  pending.resolve(approved)               // runner 里那个 await 在这一刻解冻
})
```

这就是"协程挂起"的完整形态：runner 的执行上下文冻结在 await 行（局部变量、messages 数组全部保留），主进程事件循环空出去处理别的事；用户点击经 IPC 进来，resolve 被调用，runner 从冻结处继续。批准→execute；拒绝→拒绝文本作为观察回灌（模型读到后不会重试，自测题 3 已论证）。

**停止时为什么必须先 resolve 再 abort**（chat.ts chat:stop 里的顺序）：

```ts
for (const [id, pc] of pendingConfirms) if (pc.streamId === streamId) { pc.resolve(false); ... }
activeRuns.get(streamId)?.controller.abort()
```

abort 只能让进行中的 fetch 抛错，碰不到用户自建的审批 Promise；不先 resolve，runner 永远卡在 await，ActiveRun 不摘除、Map 里的闭包泄漏。全部按"拒绝"放行后，循环走到下一轮模型请求时正好撞上 abort，统一收尾。

### E. 三层防击穿：任何失败都变成模型可读的观察

一个工具调用有三个失败点，runner 全部收编成 observation 文本，循环永远不被异常炸穿：

1. **参数 JSON 坏**（模型吐了半截/格式错）：`parseToolArgs` 返回 `{ok:false, error}`，不执行任何工具，error 文案直接当观察——模型读到"参数不是合法 JSON：…"后通常会在下一轮修正参数重试；
2. **工具名不存在**（模型幻觉了一个没注册的工具）：观察文本里附上**可用工具清单**，等于给模型一次纠偏机会；
3. **execute 内部抛异常**（磁盘满、shell.openExternal 失败等真实世界故障）：try/catch 包在 execute 外，`⚠️ 工具执行抛出异常：…` 进观察。

再加两道长度闸：观察统一截断 4000 字符（检索工具自身先截到每片 600 字、top_k 最多 10），防止一次工具返回把上下文窗口撑爆。**工具是模型的外部世界，外部世界失败是常态**——这是 Agent 与普通函数调用在错误观上的核心差别。

### F. 工具的三件套与 agent_step 的时间线落库

每个工具定义是三个面（[tools.ts](../../src/main/services/agent/tools.ts)）：

- `schema`（JSON Schema + 自然语言 description）：**给模型看的契约**，模型靠 description 决定"何时调、怎么填参"（query 的描述里甚至写了"中文 2 字以内换措辞"，把 M4 的 trigram 限制教给模型）；
- `preview(args)`：**给人看的一句话**，确认卡片上展示，禁止把完整参数裸贴（参数可能含大段文本）；
- `execute(args, ctx)`：**真正做事**，返回 `{ok, output}` 字符串契约。`requiresConfirm` 是风险分级开关：检索/时间为只读直接执行，open_url/save_note 副作用先审批。

时间线持久化：`recordStep` 每次 `insertStep({messageId, seq: seq++, ...})`，一个调用产生两个节点（tool_call + observation，可能还有 thought）。审批态在同一行上更新两次：插入时 waiting → 决议后 approved/denied（`updateStepConfirm`），所以历史时间线重建时能看到审批结果。重新生成时删除末尾 assistant 消息，agent_step 通过外键 CASCADE 自动清掉，时间线不会残留上一轮的步骤。**message 表保持纯净（只有对话），agent_step 表承载全部过程**——展示走时间线，重放走 messages 重建，各取所需。

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
7. Agent 采用"乐观流式"：工具轮的 content 分片在整轮结束前就被推进答案气泡。凭什么敢先推？如果这一轮最后发现带了 tool_calls，回滚的事件顺序是什么？文本会不会丢、为什么？
8. MAX_TOOL_ROUNDS=6 到顶后，代码用哪两道强制手段保证模型必须收尾？万一模型在没有 tools 声明的情况下仍吐了 tool_calls，runner 怎么处理？什么情况下用户会看到兜底文案？

## 自测题参考答案

**1. 不看代码画出 ReAct 一轮里 messages 数组的追加顺序，并解释"成对"为什么是协议硬要求。**

初始：`[system(Agent 规则与工具说明), ...历史对话, user(本轮问题)]`。

模型第 1 次返回带工具调用后，严格按这个顺序追加：

```
assistant { content?: 思考文本, tool_calls: [
  { id:'call_1', function:{ name:'open_url', arguments:'{...}' } },
  { id:'call_2', function:{ name:'get_current_datetime', arguments:'{}' } }
]}
tool { tool_call_id:'call_1', content:'观察结果/错误文本' }
tool { tool_call_id:'call_2', content:'2026-10-08 ...' }
```

然后拿整个数组再请求模型（第 2 轮）；若第 2 轮还调工具，再来一组 `assistant(tool_calls)` + 对应数量的 `tool`，直到某轮 assistant 没有 tool_calls——它的 content 就是最终回答。

"成对"是 OpenAI 协议的硬要求：**每个 assistant 消息里的每个 tool_call_id，下一次请求必须有且仅有一条 role='tool' 且 tool_call_id 匹配的结果消息**。缺一条、多条、id 对不上，服务端直接 400。语义上也合理：assistant 消息声明"我做了这几个调用"，tool 消息回答"每个调用的结果是什么"——请求-响应不能悬空，否则模型上下文里存在"做了动作但永远等不到结果"的非法状态。

**2. 模型把 arguments 分片吐成了 `{"url":"htt` + `p://x"}`，代码在哪一层、用什么数据结构拼回完整 JSON？**

在 [llm/client.ts](../../src/main/services/llm/client.ts) 的 SSE 解析层（runner 拿到的已经是完整工具调用）。tool_calls 和正文一样是流式增量，但它是**数组分片**：首片带 `index`、`id`、`function.name`，后续片只带同一个 `index` 和 `function.arguments` 的字符片段。归并结构是 `Map<index, 累加器>`：

- 以 `delta.tool_calls[i].index` 为 key（模型可能并行吐多个工具调用，不能按下标顺序假设）；
- 首片初始化累加器（存 id/name、arguments = ''）；
- 后续片把 `arguments` 字符串**逐片拼接**；
- 流结束后对每个累加器的 arguments 做一次 `JSON.parse`——在这一刻之前它都不是 JSON，只是半截字符串，中途 parse 必炸。

用数组末尾覆盖或"取最后一片"都会丢 id/name 或把 arguments 截断成残片。parse 失败不在这层抛，而是交给 runner 变成"参数 JSON 错误"观察让模型自纠。

**3. 用户点"拒绝"后，循环里发生了什么？模型为什么不会反复重试同一个危险操作？**

审批 Promise 被 `resolve(false)` 放行，runner **不执行工具**，而是生成一条 tool 结果消息，内容是明确的观察文本（"用户已拒绝该操作"），照常与 assistant 的 tool_calls 成对追加进 messages，然后进入下一轮模型请求。

模型读到的上下文是："我请求打开这个链接 → 用户拒绝了"。协议上这次工具调用已经完整结束（有结果了），模型没有理由、也没有机制自动重发同一个调用——它要么换方案（用已有信息回答）、要么向用户解释为什么需要这个操作、让用户自己决定是否重新提问。真正需要用户再次授权时，模型会发起一个**新的** tool_call，UI 会再弹一次确认卡。也就是说，防重试不是靠代码硬拦"同名工具只能调一次"，而是靠"拒绝结果回流给模型"这种协议层面的反馈；副作用工具白名单（`^https?://`、保存对话框）则是纵深防御。

**4. 为什么 `chat:stop` 要先 resolve 挂起审批再 abort？少这一步会泄漏什么？**

因为审批的挂起点是 runner 里的 `await new Promise(resolve => pendingConfirms.set(confirmId, {resolve, streamId}))`——这个 Promise 跟 HTTP 请求没有任何关系，`AbortController.abort()` 只能中断 fetch，碰不到它。

如果只 abort 模型请求：

- 正卡在审批 await 上的那次工具调用根本没发出模型请求（或正在等用户），abort 对它无意义，Promise 永远 pending；
- runner 协程永远停在 await，不会走到任何收尾逻辑（streamId 的 ActiveRun 不摘除、streaming 占位消息不更新）；
- `pendingConfirms` Map 里的 resolver 与其闭包（streamId、回调引用）永不释放 = 资源泄漏；此时用户若在陈旧的确认卡上点按钮，还会 resolve 一个已经"停止"的运行，行为未定义。

正确顺序：先遍历本次 streamId 的挂起审批全部 `resolve(false)`（按"拒绝"语义给模型/收尾一个确定结果，循环解开），再 abort 进行中的模型请求，最后统一走 stop 收尾。

**5. 一个工具执行时抛了未预期异常，用户在界面上会看到什么？为什么看不到红色崩溃？**

时间线上该工具步骤会停在"已调用"并收到一条 observation 观察条目，内容是被捕获的错误信息（执行输出统一截断到 4000 字，防止超长报错刷爆上下文）；对话继续——模型读到"工具执行失败：<原因>"后通常会自纠（改参数重试）或向用户说明失败原因并给出替代方案。

看不到红色崩溃是因为工具契约规定 **execute 永不抛穿**：所有工具的 execute 统一返回 `{ok, output}` 形态，runner 对每个调用都 try/catch，把任何异常（不只是"预期内"的）转写成 observation 文本。工具是模型的"外部世界"，外部世界失败是正常事件（网页打不开、用户取消了保存对话框、路径无权限），要变成模型能读懂的文字，而不是炸穿整个 ReAct 循环、把一次工具失败升级成整轮对话失败。未捕获异常只剩在主进程日志里，不会传导成渲染端错误条。

**6. 为什么不把 tool 角色消息也存进 message 表？**

两类消息的用途完全不同：

- `role:'tool'` 消息是**喂给模型的协议构件**，用来满足"tool_calls 必须配对"的 API 要求，内容是机器读的观察文本（错误、检索片段 JSON、时间字符串），不是给人看的聊天记录；
- 用户可见的对话历史应该只有"用户说了什么、助手最终回答了什么"。如果把 tool 消息混进 message 表，会话列表渲染要到处过滤角色，`buildChatHistory` 的语义被污染，重新生成/继续对话时还要小心这些内部构件的顺序与配对（少一条就 400）。

所以设计成两层：`message` 表只存 user 消息和 assistant 最终文本（M5 后 assistant 的中间思考也不入气泡）；💭思考 / 🔧工具调用 / ↳观察以 `agent_step` 行挂在 assistant 消息 id 下（带 seq、审批状态），仅供历史时间线重建展示。需要重放 Agent 协议时由 steps 重建工具轮，而不是依赖 message 表。

**7. Agent 采用"乐观流式"：工具轮的 content 分片在整轮结束前就被推进答案气泡。凭什么敢先推？如果这一轮最后发现带了 tool_calls，回滚的事件顺序是什么？文本会不会丢、为什么？**

敢先推的原因是 SSE 的到达顺序：一轮里 content 分片先到，而这一轮"有没有工具调用"要到该轮响应末尾的 tool_calls 分片才知道。若等整轮解析完再显示，长思考期间气泡几十秒沉默，体验不可接受；而"推错了可以撤回"的成本极低——chat.ts 侧只是一个累积字符串。

回滚事件顺序（runner.callModel 整轮结束后）：

1. callModel 过程中每片 content 已经 `onAnswerDelta → emit token`，chat 累积进当前 assistant 气泡，用户看到字在滚；
2. 发现 `turn.toolCalls.length > 0`：先调 `onAnswerReset()`——chat 把本轮累积的答案文本清零并广播 `agent_answer_reset` 事件，渲染端清空气泡；
3. 同一段文本（`turn.content.trim()`）立刻以 `thought` 步骤 `recordStep` 落库并推 `agent_step` 事件，出现在时间线的 💭思考折叠区（qwen 工具轮 content 常为空，空就不产生 thought 节点）。

文本不丢：同一份 `buffered`/turn.content 只有两个去向——工具轮转 thought，最终轮留气泡，归属在"轮末有没有 tool_calls"这一刻决定，但内容始终被完整保存。最终轮（无 tool_calls）不 reset，气泡里的分片就是最终答案；只有模型连最终文本都只吐空白时，runner 才补一条兜底文案 onAnswerDelta。

**8. MAX_TOOL_ROUNDS=6 到顶后，代码用哪两道强制手段保证模型必须收尾？万一模型在没有 tools 声明的情况下仍吐了 tool_calls，runner 怎么处理？什么情况下用户会看到兜底文案？**

两道手段是"声明层 + 提示词层"（[runner.ts](../../src/main/services/agent/runner.ts)）：

1. **声明层（物理手段）**：第 7 次进循环时 `toolsAvailable = toolRounds < 6 ? TOOL_SCHEMAS : undefined`，请求体里压根不带 tools 字段。协议上没有工具声明，模型就无法合法产生 tool_calls；
2. **提示词层**：达到上限的那一轮工具执行完后，往 messages 追加一条 user 消息："（系统提示：工具调用轮数已达上限，请不要再调用工具，基于以上观察直接给出最终回答。）"，引导模型基于已有观察收尾。

模型仍硬吐 tool_calls 的兜底：循环出口判断是 `turn.toolCalls.length === 0 || toolsAvailable === undefined`——只要 toolsAvailable 是 undefined（即到顶后的请求），即使返回里带了 tool_calls 也**一律不执行、不追加消息**，直接把 turn.content 当最终回答返回。防止小模型无视系统提示把循环拖死。

兜底文案"（已达到工具调用上限，且模型未给出文本结论，请基于以上步骤结果查看。）"出现在：到顶后这一轮的 content trim 后为空（模型只吐了被丢弃的 tool_calls、一个字没说）。它通过 `onAnswerDelta` 补进气泡，保证用户不会看到一条空的 assistant 消息；若模型给了文本（哪怕只有一句），就用真实文本、不显示兜底。
