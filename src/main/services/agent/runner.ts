import { randomUUID } from 'node:crypto'
import type {
  AgentStepInfo,
  ChatMessage,
  ToolCall
} from '../../../shared/types'
import { streamChatCompletion, type ToolSchema } from '../llm/client'
import type { EmbeddingDeps } from '../rag/embedder'
import { insertStep, updateStepConfirm } from './repo'
import { getTool, TOOL_SCHEMAS, type ToolExecutionContext } from './tools'

/**
 * Agent 执行循环（M5 核心：ReAct = 推理 ⇄ 行动 ⇄ 观察 的多轮闭环）
 *
 * 与 RAG 的本质区别：
 * - RAG 是"先检索一次 → 资料塞进 prompt → 单轮生成"，检索次数由代码决定；
 * - Agent 由模型自己决定"要不要调工具、调哪个、传什么参数、要不要再查一次"，
 *   直到它认为信息足够，给出最终自然语言回答。
 *
 * 一轮的形态：
 *   assistant(content?=思考, toolCalls[]) → 逐个执行工具
 *   → tool(observation) 回灌 → 再来一轮 …
 *   → assistant(无 toolCalls) 即最终回答
 *
 * 安全护栏：
 * - MAX_TOOL_ROUNDS 限制工具轮数（防模型陷入"反复检索"死循环），到顶后
 *   摘掉 tools 强制模型基于已有观察收尾
 * - 副作用工具执行前经 onConfirm 挂起等用户审批，AbortError 由上层识别停止
 * - 工具自身/参数解析的异常全部转成 observation 文本，循环不被击穿
 */

export const MAX_TOOL_ROUNDS = 6

export interface ModelConfigLite {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AgentRunnerDeps {
  modelConfig: ModelConfigLite
  temperature: number
  /** 用户设置的人设，runner 在其上追加 Agent 规则 */
  systemPrompt: string
  /** assistant 占位消息 id（步骤落库挂载点） */
  messageId: string
  /** 会话绑定知识库（检索工具默认目标），可为空 */
  kbId?: string
  embedding: EmbeddingDeps
  signal: AbortSignal
  /**
   * 最终回答的增量文本。Agent 采用"乐观流式"：每一轮的 content 分片都
   * 先实时推送（不缓冲到整轮结束，否则长答案要等工具协议解析完才有字），
   * 若该轮最终带了 tool_calls，说明这些分片是思考独白而非答案，
   * 紧接着会回调 onAnswerReset 要求清空，文本转由 thought 步骤展示。
   */
  onAnswerDelta?: (delta: string) => void
  /** 工具轮收尾：清空本轮误推给气泡的思考文本 */
  onAnswerReset?: () => void
  onStep?: (step: AgentStepInfo) => void
  /** 副作用工具审批：resolve(true)=批准执行 / false=拒绝（注入拒绝观察） */
  onConfirm?: (request: {
    confirmId: string
    stepId: string
    toolName: string
    args: unknown
    preview: string
  }) => Promise<boolean>
}

export interface AgentRunResult {
  content: string
  promptTokens: number
  completionTokens: number
  toolRounds: number
}

/** Agent 系统提示：在用户设定的人设之上追加"如何当一个工具使用者"的规则 */
export function buildAgentSystemPrompt(base: string, hasKb: boolean): string {
  return `${base.trim()}

你正在以「智能体（Agent）」模式工作，可以通过调用工具获取信息或完成操作。
规则：
1. 需要查阅本地资料${hasKb ? '' : '（注意：当前未绑定知识库，检索前请提示用户先在知识库页选择/导入）'}、时间或需要打开链接、保存文件时，调用相应工具，不要凭空编造工具结果；
2. 仔细阅读每次工具返回的 observation，信息不足可以换关键词再次检索，但不要重复完全相同的无效调用；
3. 拿到足够信息后直接给出最终回答（不要再调用工具），回答用中文，条理清晰；
4. 工具失败时根据报错自行纠正参数重试一次；若仍失败，如实告诉用户原因；
5. open_url / save_note 这类操作必须等待用户确认，被拒绝后不要重试，向用户说明即可。`
}

/** 解析模型产出的参数 JSON；失败返回错误标记，由调用方转成 observation */
function parseToolArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: true, args: {} }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `工具参数必须是 JSON 对象，实际得到：${text.slice(0, 200)}` }
    }
    return { ok: true, args: parsed as Record<string, unknown> }
  } catch (e) {
    return { ok: false, error: `参数不是合法 JSON：${(e as Error).message}；原始片段：${text.slice(0, 200)}` }
  }
}

async function callModel(
  messages: ChatMessage[],
  deps: AgentRunnerDeps,
  tools: ToolSchema[] | undefined
): Promise<{ content: string; toolCalls: ToolCall[]; promptTokens: number; completionTokens: number }> {
  const gen = streamChatCompletion({
    baseUrl: deps.modelConfig.baseUrl,
    apiKey: deps.modelConfig.apiKey,
    model: deps.modelConfig.model,
    temperature: deps.temperature,
    messages,
    signal: deps.signal,
    tools
  })
  // 工具轮的 content 可能是模型的"思考独白"：逐片缓冲落库用，同时实时
  // 推给气泡（乐观流式）；若整轮结束发现带 tool_calls，由调用方回滚。
  let buffered = ''
  while (true) {
    const { value, done } = await gen.next()
    if (done) {
      return {
        content: value.content || buffered,
        toolCalls: value.toolCalls,
        promptTokens: value.promptTokens,
        completionTokens: value.completionTokens
      }
    }
    buffered += value
    deps.onAnswerDelta?.(value)
  }
}

export async function runAgent(
  userMessage: string,
  history: ChatMessage[],
  deps: AgentRunnerDeps
): Promise<AgentRunResult> {
  const toolCtx: ToolExecutionContext = {
    kbId: deps.kbId,
    embedding: deps.embedding
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildAgentSystemPrompt(deps.systemPrompt, !!deps.kbId) },
    ...history,
    { role: 'user', content: userMessage }
  ]

  let promptTokens = 0
  let completionTokens = 0
  let toolRounds = 0
  let seq = 0
  const recordStep = (input: {
    stepType: 'thought' | 'tool_call' | 'observation'
    toolName?: string
    args?: unknown
    result?: string
    confirmId?: string
    confirmStatus?: AgentStepInfo['confirmStatus']
  }): AgentStepInfo => {
    const step = insertStep({ messageId: deps.messageId, seq: seq++, ...input })
    deps.onStep?.(step)
    return step
  }

  while (true) {
    const toolsAvailable = toolRounds < MAX_TOOL_ROUNDS ? TOOL_SCHEMAS : undefined
    const turn = await callModel(messages, deps, toolsAvailable)
    promptTokens += turn.promptTokens
    completionTokens += turn.completionTokens

    // 无工具调用 = 最终回答。
    // toolsAvailable=undefined（达到轮数上限）时即使模型无视约定仍吐
    // tool_calls，也不再执行，强制用已有观察收尾，避免无限循环。
    if (turn.toolCalls.length === 0 || toolsAvailable === undefined) {
      const trimmed = turn.content.trim()
      const finalText =
        trimmed ||
        '（已达到工具调用上限，且模型未给出文本结论，请基于以上步骤结果查看。）'
      // 分片已在 callModel 里实时推过；模型只吐空白时补一条兜底文案
      if (!trimmed) deps.onAnswerDelta?.(finalText)
      return {
        content: finalText,
        promptTokens,
        completionTokens,
        toolRounds
      }
    }

    // 本轮确认要执行工具
    toolRounds += 1

    // 乐观推送的文本证实是思考独白：先清空答案气泡，再以 thought 节点
    // 展示同一段内容（UI 上表现为文字从气泡移入时间线的"思考"折叠区）
    deps.onAnswerReset?.()

    // 思考独白（qwen 工具轮常为空；有则记录，让时间线展示模型在想什么）
    if (turn.content.trim()) {
      recordStep({ stepType: 'thought', result: turn.content.trim() })
    }

    // 本轮 assistant 消息原样进上下文（tool_calls 必须与后续 tool 消息成对）
    messages.push({
      role: 'assistant',
      content: turn.content,
      toolCalls: turn.toolCalls
    })

    // 逐个执行：每个调用产出 tool_call + observation 两个时间线节点
    for (const call of turn.toolCalls) {
      const parsed = parseToolArgs(call.arguments)
      const tool = getTool(call.name)

      const args = parsed.ok ? parsed.args : {}
      const callStep = recordStep({
        stepType: 'tool_call',
        toolName: call.name,
        args,
        confirmStatus: tool?.requiresConfirm ? 'waiting' : undefined
      })

      let observation: string
      if (!parsed.ok) {
        observation = parsed.error
      } else if (!tool) {
        observation = `工具不存在：${call.name}。可用工具：${TOOL_SCHEMAS.map((t) => t.function.name).join('、')}`
      } else {
        let approved = true
        if (tool.requiresConfirm) {
          const confirmId = randomUUID()
          updateStepConfirm(callStep.id, { confirmId, confirmStatus: 'waiting' })
          const waitingStep = { ...callStep, confirmId, confirmStatus: 'waiting' as const }
          deps.onStep?.(waitingStep)
          approved = (await deps.onConfirm?.({
            confirmId,
            stepId: callStep.id,
            toolName: call.name,
            args,
            preview: tool.preview(args)
          })) ?? false
          updateStepConfirm(callStep.id, { confirmStatus: approved ? 'approved' : 'denied' })
          deps.onStep?.({ ...waitingStep, confirmStatus: approved ? 'approved' : 'denied' })
        }
        if (!approved) {
          observation = '用户拒绝了该操作。不要重试，直接向用户说明并询问下一步。'
        } else {
          try {
            const r = await tool.execute(args, toolCtx)
            observation = `${r.ok ? '✅' : '⚠️'} ${r.output}`
          } catch (e) {
            // 工具执行异常（如磁盘错误、外部程序失败）转为观察，循环继续
            observation = `⚠️ 工具执行抛出异常：${(e as Error).message}`
          }
        }
      }

      // 观察结果限长，防止工具大输出把上下文撑爆（检索工具已自行截断，此处双保险）
      const clipped =
        observation.length > 4000 ? observation.slice(0, 4000) + '\n…（结果过长已截断）' : observation
      recordStep({ stepType: 'observation', toolName: call.name, result: clipped })
      messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: clipped
      })
    }

    if (toolRounds >= MAX_TOOL_ROUNDS) {
      messages.push({
        role: 'user',
        content:
          '（系统提示：工具调用轮数已达上限，请不要再调用工具，基于以上观察直接给出最终回答。）'
    })
    }
  }
}
