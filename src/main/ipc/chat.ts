import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import {
  addMessage,
  autoTitleFromFirstMessage,
  buildChatHistory,
  createConversation,
  touchConversation,
  updateMessage
} from '../services/conversations/repo'
import { getSettings } from '../services/settings/repo'
import { getCloudApiKey } from '../store/secrets'
import { streamChatCompletion } from '../services/llm/client'
import { compactIfNeeded, estimateTokens } from '../services/llm/context'
import { resolveModelConfig } from '../services/llm/resolve'
import { buildRagSystemPrompt, retrieve, snippetOf } from '../services/rag/retriever'
import { runAgent } from '../services/agent/runner'
import type { AgentStepInfo, CitationRef } from '../../shared/types'
import type { RunPayload, StreamEvent } from '../../shared/protocol'

/**
 * 对话运行管理（F-A1 流式 / 停止；F-A2 多轮压缩）
 *
 * 通信模式（PRD 13.1/13.2）：
 * - chat:run 是"发起后立刻返回"的 invoke：同步返回 streamId，真正的生成在后台跑，
 *   所有过程通过 webContents.send('chat:event', StreamEvent) 推给渲染端；
 * - chat:stop 找到该 streamId 的 AbortController 中断 fetch。
 */

interface ActiveRun {
  controller: AbortController
}

const activeRuns = new Map<string, ActiveRun>()

/**
 * M5：等待用户审批的副作用工具调用。
 * runner 在 onConfirm 处 await 一个 Promise，审批结果由
 * chat:confirm-resolve 唤醒；停止生成时同一批 resolve(false)，
 * 避免挂起的 Promise 泄漏（随后 abort 让下一轮请求抛 AbortError）。
 */
interface PendingConfirm {
  resolve: (approved: boolean) => void
  streamId: string
}
const pendingConfirms = new Map<string, PendingConfirm>()

function emit(target: WebContents, event: StreamEvent): void {
  target.send('chat:event', event)
}

async function executeRun(
  target: WebContents,
  streamId: string,
  payload: RunPayload
): Promise<void> {
  const settings = getSettings()
  const cloudApiKey = getCloudApiKey()

  // 解析本次使用的模型配置（云端 / Ollama 统一归一化为 OpenAI 兼容配置）
  const resolved = resolveModelConfig(settings, cloudApiKey)
  const modelLabel = resolved.ok ? resolved.config.model : settings.model

  // 1. 会话（不传 id 则隐式新建），记录当时实际使用的模型
  const conversationId =
    payload.conversationId ?? createConversation(payload.mode, modelLabel).id

  // 2. 用户消息先落库（写入前持久化，PRD 第 6 章：崩溃不丢）
  const userMsg = addMessage({ conversationId, role: 'user', content: payload.message })
  if (userMsg.seq === 1) {
    autoTitleFromFirstMessage(conversationId, payload.message)
  }
  touchConversation(conversationId, modelLabel)

  // 3. assistant 占位消息（streaming 状态先落库）
  const assistantMsg = addMessage({
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming'
  })

  emit(target, { type: 'start', streamId, conversationId, messageId: assistantMsg.id })

  const fail = (message: string) => {
    updateMessage(assistantMsg.id, { status: 'error' })
    emit(target, { type: 'error', streamId, message })
  }

  if (!resolved.ok) {
    fail(resolved.message)
    return
  }
  const modelConfig = resolved.config

  // 4. 组装上下文：system + 历史 + 本轮，超限先压缩（F-A2）
  let history = buildChatHistory(conversationId)
  try {
    history = await compactIfNeeded(history, settings, {
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey
    })
  } catch (e) {
    // 摘要失败不应阻断主流程：降级为用未压缩历史直接请求
    console.warn('[chat] 上下文压缩失败，降级继续：', e)
  }

  // 4.5 RAG 模式：先检索知识库，引用资料注入 system，并按序发 citation 事件
  // 编号 [1..n] 同时用于：注入资料的序号、模型回答中的角标、渲染端引用卡片
  let systemContent = settings.systemPrompt.trim()
  // 本轮引用，随 assistant 消息持久化（历史会话也能回看来源）
  const citations: CitationRef[] = []
  if (payload.mode === 'rag') {
    if (!payload.kbId) {
      fail('缺少知识库信息，无法进行知识库问答。')
      return
    }
    let retrieved
    try {
      retrieved = await retrieve(payload.message, payload.kbId, {
        settings,
        cloudApiKey
      })
    } catch (e) {
      fail(`知识库检索失败：${(e as Error).message}`)
      return
    }
    for (const chunk of retrieved) {
      const ref: CitationRef = {
        chunkId: chunk.id,
        docName: chunk.docName ?? '未命名文档',
        snippet: snippetOf(chunk.content),
        page: typeof chunk.meta.page === 'number' ? chunk.meta.page : null
      }
      citations.push(ref)
      emit(target, { type: 'citation', streamId, ...ref })
    }
    systemContent = buildRagSystemPrompt(systemContent, retrieved)
  }

  // 5. 控制器注册（chat/rag/agent 共用停止入口）
  const controller = new AbortController()
  activeRuns.set(streamId, { controller })

  let answer = ''
  let promptTokens = 0
  let completionTokens = 0

  const emitStep = (step: AgentStepInfo): void => {
    emit(target, {
      type: 'agent_step',
      streamId,
      seq: step.seq,
      stepId: step.id,
      stepType: step.stepType,
      toolName: step.toolName,
      args: step.args,
      result: step.result,
      confirmStatus: step.confirmStatus
    })
  }

  try {
    if (payload.mode === 'agent') {
      // ---- Agent 模式：ReAct 多轮工具循环（system 规则由 runner 在人设上追加）----
      const result = await runAgent(payload.message, history, {
        modelConfig: {
          baseUrl: modelConfig.baseUrl,
          apiKey: modelConfig.apiKey,
          model: modelConfig.model
        },
        temperature: settings.temperature,
        systemPrompt: settings.systemPrompt,
        messageId: assistantMsg.id,
        kbId: payload.kbId,
        embedding: { settings, cloudApiKey },
        signal: controller.signal,
        onAnswer: (text) => {
          // 最终轮一次性出文（工具轮的思考不进气泡）
          answer = text
          emit(target, { type: 'token', streamId, delta: text })
        },
        onStep: emitStep,
        onConfirm: (req) =>
          new Promise<boolean>((resolve) => {
            // runner 在此挂起，直到 chat:confirm-resolve 或 chat:stop 唤醒
            pendingConfirms.set(req.confirmId, { resolve, streamId })
            emit(target, { type: 'confirm_required', streamId, ...req })
          })
      })
      answer = result.content
      promptTokens = result.promptTokens
      completionTokens = result.completionTokens
    } else {
      // ---- chat / rag 模式：M1-M4 的单轮流式（rag 已在上方把资料注入 system）----
      const messages = systemContent
        ? [{ role: 'system' as const, content: systemContent }, ...history]
        : history
      const gen = streamChatCompletion({
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        temperature: settings.temperature,
        messages,
        signal: controller.signal
      })
      while (true) {
        const { value, done } = await gen.next()
        if (done) {
          // done 分支 value 类型被 TS 收窄为生成器返回值 StreamResult
          answer = value.content || answer
          promptTokens = value.promptTokens
          completionTokens = value.completionTokens
          break
        }
        answer += value
        emit(target, { type: 'token', streamId, delta: value })
      }
    }

    // 6. 收尾落库（用完整文本回写，比逐 token UPDATE 高效得多）
    updateMessage(assistantMsg.id, {
      content: answer,
      status: 'done',
      tokens: completionTokens || estimateTokens(answer),
      citations
    })
    touchConversation(conversationId, modelConfig.model)
    emit(target, {
      type: 'done',
      streamId,
      usage: { promptTokens, completionTokens }
    })
  } catch (e) {
    activeRuns.delete(streamId)
    if ((e as Error).name === 'AbortError') {
      // 用户主动停止：保留已生成片段，正常收尾而非报错（F-A1）
      const partial = answer.trim()
      updateMessage(assistantMsg.id, {
        content: partial || '（已停止生成）',
        status: 'done',
        tokens: estimateTokens(partial),
        citations
      })
      touchConversation(conversationId)
      emit(target, { type: 'done', streamId, usage: null })
      return
    }
    // 真错误：保留片段并标记 error，错误事件驱动 UI 提示
    if (answer.trim()) {
      updateMessage(assistantMsg.id, { content: answer, citations })
    }
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    activeRuns.delete(streamId)
    // 兜底清理本流残留的审批挂起（正常路径审批在循环内已被消费）
    for (const [id, pc] of pendingConfirms) {
      if (pc.streamId === streamId) {
        pc.resolve(false)
        pendingConfirms.delete(id)
      }
    }
  }
}

export function registerChatHandlers(): void {
  // 发起运行：立即返回 streamId，后台异步推送事件
  ipcMain.handle('chat:run', (event, payload: RunPayload): string => {
    const streamId = randomUUID()
    // 不 await：让 invoke 立刻拿到 streamId 返回给渲染端
    void executeRun(event.sender, streamId, payload)
    return streamId
  })

  ipcMain.handle('chat:stop', (_event, streamId: string) => {
    // 先放行该流上挂起的审批（按拒绝处理），再中断网络请求；
    // 否则 runner 会永远 await 在 onConfirm 上，abort 也碰不到它
    for (const [id, pc] of pendingConfirms) {
      if (pc.streamId === streamId) {
        pc.resolve(false)
        pendingConfirms.delete(id)
      }
    }
    activeRuns.get(streamId)?.controller.abort()
  })

  // M5：用户对副作用工具确认卡片的审批结果
  ipcMain.handle(
    'chat:confirm-resolve',
    (_event, payload: { confirmId: string; approved: boolean }) => {
      const pending = pendingConfirms.get(payload.confirmId)
      if (!pending) return // 已超时/随停止清理：忽略重复点击
      pendingConfirms.delete(payload.confirmId)
      pending.resolve(payload.approved)
    }
  )
}
