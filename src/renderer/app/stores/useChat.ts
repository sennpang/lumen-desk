import { create } from 'zustand'
import { api } from '../lib/ipc'
import { useConversations } from './useConversations'
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

  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  handleEvent: (ev: StreamEvent) => Promise<void>
  clearError: () => void
}

export const useChat = create<ChatState>((set, get) => ({
  activeRun: null,
  error: null,
  sending: false,

  async send(text) {
    const content = text.trim()
    if (!content || get().activeRun || get().sending) return

    set({ error: null, sending: true })
    try {
      const currentId = useConversations.getState().currentId
      const streamId = await api.chat.run({
        conversationId: currentId ?? undefined,
        mode: 'chat',
        message: content
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
      // M3/M5 事件：M1 先显式忽略，保证 reducer 对判别联合的穷尽
      case 'citation':
      case 'agent_step':
      case 'confirm_required':
        break
    }
  },

  clearError() {
    set({ error: null })
  }
}))
