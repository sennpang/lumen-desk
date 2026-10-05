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
      emit(target, {
        type: 'citation',
        streamId,
        chunkId: chunk.id,
        docName: chunk.docName ?? '未命名文档',
        snippet: snippetOf(chunk.content),
        page: typeof chunk.meta.page === 'number' ? chunk.meta.page : null
      })
    }
    systemContent = buildRagSystemPrompt(systemContent, retrieved)
  }

  const messages = systemContent
    ? [{ role: 'system' as const, content: systemContent }, ...history]
    : history

  // 5. 流式请求
  const controller = new AbortController()
  activeRuns.set(streamId, { controller })

  let answer = ''
  let promptTokens = 0
  let completionTokens = 0
  try {
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

    // 6. 收尾落库（用完整文本回写，比逐 token UPDATE 高效得多）
    updateMessage(assistantMsg.id, {
      content: answer,
      status: 'done',
      tokens: completionTokens || estimateTokens(answer)
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
        tokens: estimateTokens(partial)
      })
      touchConversation(conversationId)
      emit(target, { type: 'done', streamId, usage: null })
      return
    }
    // 真错误：保留片段并标记 error，错误事件驱动 UI 提示
    if (answer.trim()) updateMessage(assistantMsg.id, { content: answer })
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    activeRuns.delete(streamId)
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
    activeRuns.get(streamId)?.controller.abort()
  })
}
