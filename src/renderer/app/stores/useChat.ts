import { create } from 'zustand'
import { api } from '../lib/ipc'
import { useConversations } from './useConversations'
import { useKnowledge } from './useKnowledge'
import type { ChatMode } from '../../../shared/types'
import type { StreamEvent } from '../../../shared/protocol'

/**
 * 对话运行状态（F-A1）：当前是否在生成、流式事件 reducer、发送/停止。
 *
 * 与 useConversations 的分工：
 * - 本 store 管"一次运行"的生命周期（streamId / 错误）
 * - 消息内容的落地放在 conversations store（列表渲染只认它）
 */
interface ActiveRun {
  streamId: string
  conversationId: string
  messageId: string
}

/** 等待用户审批的副作用工具卡片（runner 同时只挂起一个，按 stepId 索引） */
export interface ConfirmCard {
  confirmId: string
  stepId: string
  toolName: string
  args: unknown
  preview: string
}

interface ChatState {
  activeRun: ActiveRun | null
  error: string | null
  /** 发送中（invoke 返回前的极短窗口，禁用发送按钮） */
  sending: boolean
  /** M5：待审批工具卡片，key = stepId（挂在时间线对应节点下） */
  confirms: Record<string, ConfirmCard>

  /**
   * @param mode 普通对话 / 知识库问答 / 智能体；隐式新建会话时写入 conversation.mode
   * @param kbId rag 必带；agent 带了作为检索工具的默认知识库
   */
  send: (text: string, mode?: ChatMode, kbId?: string) => Promise<void>
  /** 重新生成最后一轮回答（旧 assistant 消息主进程会删，重跑最后一条 user） */
  regenerate: () => Promise<void>
  stop: () => Promise<void>
  /** M5：审批副作用工具；乐观移除卡片（主进程对重复点击幂等） */
  resolveConfirm: (stepId: string, approved: boolean) => Promise<void>
  handleEvent: (ev: StreamEvent) => Promise<void>
  clearError: () => void
}

export const useChat = create<ChatState>((set, get) => ({
  activeRun: null,
  error: null,
  sending: false,
  confirms: {},

  async send(text, mode = 'chat', kbId) {
    const content = text.trim()
    if (!content || get().activeRun || get().sending) return

    set({ error: null, sending: true })
    try {
      const currentId = useConversations.getState().currentId
      const streamId = await api.chat.run({
        conversationId: currentId ?? undefined,
        mode,
        message: content,
        // rag 必须有库；agent 可空（时间/链接/保存仍可用），有则带上
        ...(mode !== 'chat' && kbId ? { kbId } : {})
      })
      // activeRun 在 start 事件里设置（那里能拿到 assistant messageId）
      void streamId
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ sending: false })
    }
  },

  async regenerate() {
    const convState = useConversations.getState()
    const { currentId, messages, list } = convState
    if (!currentId || get().activeRun || get().sending) return
    // 没有 user 消息说明会话是空的（理论上按钮也不会出现，双保险）
    if (!messages.some((m) => m.role === 'user')) return
    const mode = list.find((c) => c.id === currentId)?.mode ?? 'chat'
    // rag/agent 复用当前选中的知识库；chat 不需要
    const kbId =
      mode === 'chat' ? undefined : (useKnowledge.getState().currentKbId ?? undefined)

    set({ error: null, sending: true })
    try {
      await api.chat.regenerate({ conversationId: currentId, mode, kbId })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      // 主进程在 start 之前就拦下的错误不会触发 hydrate，手动刷一次
      await convState.hydrateCurrent()
    } finally {
      set({ sending: false })
    }
  },

  async stop() {
    const run = get().activeRun
    if (run) await api.chat.stop(run.streamId)
  },

  async resolveConfirm(stepId, approved) {
    const card = get().confirms[stepId]
    if (!card) return
    // 先乐观收起卡片，状态以随后到达的 agent_step(approved/denied) 为准
    set((s) => {
      const next = { ...s.confirms }
      delete next[stepId]
      return { confirms: next }
    })
    await api.chat.resolveConfirm(card.confirmId, approved)
  },

  async handleEvent(ev) {
    const conv = useConversations.getState()
    switch (ev.type) {
      case 'start': {
        set({
          activeRun: {
            streamId: ev.streamId,
            conversationId: ev.conversationId,
            messageId: ev.messageId
          },
          error: null,
          confirms: {}
        })
        // 隐式新建会话的场景：start 才是真正的会话 id 第一次出现的地方
        if (conv.currentId !== ev.conversationId) {
          await useConversations.getState().select(ev.conversationId)
        } else {
          await conv.hydrateCurrent()
        }
        // 标题/排序可能已变（首条消息自动起标题）
        await useConversations.getState().refreshList()
        break
      }
      case 'token': {
        const run = get().activeRun
        if (run) useConversations.getState().appendStreaming(run.messageId, ev.delta)
        break
      }
      case 'citation': {
        // 检索完成、正文开始前到达；先挂到占位 assistant 消息上即时渲染，
        // done 时 hydrate 会用持久化版本覆盖（同一份数据）
        const run = get().activeRun
        if (run) {
          const { chunkId, docName, snippet, page } = ev
          useConversations
            .getState()
            .attachCitation(run.messageId, { chunkId, docName, snippet, page })
        }
        break
      }
      case 'error': {
        set({ activeRun: null, error: ev.message, confirms: {} })
        await useConversations.getState().hydrateCurrent()
        await useConversations.getState().refreshList()
        break
      }
      case 'done': {
        set({ activeRun: null, confirms: {} })
        // 以数据库最终状态为准整体回填（status/tokens/停止后的片段）
        await useConversations.getState().hydrateCurrent()
        await useConversations.getState().refreshList()
        break
      }
      case 'agent_step': {
        const run = get().activeRun
        if (!run) break
        // 事件字段 → AgentStepInfo；createdAt 仅临时渲染用，done 后以库回填为准
        useConversations.getState().upsertAgentStep(run.messageId, {
          id: ev.stepId,
          messageId: run.messageId,
          seq: ev.seq,
          stepType: ev.stepType,
          toolName: ev.toolName,
          args: ev.args,
          result: ev.result,
          confirmStatus: ev.confirmStatus,
          createdAt: Date.now()
        })
        break
      }
      case 'confirm_required': {
        set((s) => ({
          confirms: {
            ...s.confirms,
            [ev.stepId]: {
              confirmId: ev.confirmId,
              stepId: ev.stepId,
              toolName: ev.toolName,
              args: ev.args,
              preview: ev.preview
            }
          }
        }))
        break
      }
    }
  },

  clearError() {
    set({ error: null })
  }
}))
