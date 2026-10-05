import { create } from 'zustand'
import { api } from '../lib/ipc'
import { useConversations } from './useConversations'
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

interface ChatState {
  activeRun: ActiveRun | null
  error: string | null
  /** 发送中（invoke 返回前的极短窗口，禁用发送按钮） */
  sending: boolean

  /**
   * @param mode 普通对话或知识库问答；隐式新建会话时写入 conversation.mode
   * @param kbId mode='rag' 时必填
   */
  send: (text: string, mode?: ChatMode, kbId?: string) => Promise<void>
  stop: () => Promise<void>
  handleEvent: (ev: StreamEvent) => Promise<void>
  clearError: () => void
}

export const useChat = create<ChatState>((set, get) => ({
  activeRun: null,
  error: null,
  sending: false,

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
        ...(mode === 'rag' && kbId ? { kbId } : {})
      })
      // activeRun 在 start 事件里设置（那里能拿到 assistant messageId）
      void streamId
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ sending: false })
    }
  },

  async stop() {
    const run = get().activeRun
    if (run) await api.chat.stop(run.streamId)
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
          error: null
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
        set({ activeRun: null, error: ev.message })
        await useConversations.getState().hydrateCurrent()
        await useConversations.getState().refreshList()
        break
      }
      case 'done': {
        set({ activeRun: null })
        // 以数据库最终状态为准整体回填（status/tokens/停止后的片段）
        await useConversations.getState().hydrateCurrent()
        await useConversations.getState().refreshList()
        break
      }
      // M5 事件：M3 先显式忽略，保证 reducer 对判别联合的穷尽
      case 'agent_step':
      case 'confirm_required':
        break
    }
  },

  clearError() {
    set({ error: null })
  }
}))
