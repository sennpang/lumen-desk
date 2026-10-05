import { create } from 'zustand'
import { api } from '../lib/ipc'
import type { ChatMode, ConversationInfo, MessageRecord } from '../../../shared/types'

/**
 * 会话状态（F-A3）：会话列表、当前会话、当前消息数组。
 *
 * 单一数据源原则：消息的"真相"在主进程 SQLite，
 * 渲染端这份 store 只是缓存——切换/流式结束时整体 hydrate，
 * 流式过程中为性能只做本地追加，不逐条查库。
 */
interface ConversationsState {
  list: ConversationInfo[]
  currentId: string | null
  messages: MessageRecord[]
  listLoading: boolean

  refreshList: () => Promise<void>
  createNew: (mode?: ChatMode) => Promise<string>
  select: (id: string) => Promise<void>
  hydrateCurrent: () => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  reset: () => void

  /** 流式 token 到达时本地追加到对应 assistant 消息（避免每 token 查库） */
  appendStreaming: (messageId: string, delta: string) => void
}

export const useConversations = create<ConversationsState>((set, get) => ({
  list: [],
  currentId: null,
  messages: [],
  listLoading: false,

  async refreshList() {
    set({ listLoading: true })
    try {
      const list = await api.conversation.list()
      set({ list })
    } finally {
      set({ listLoading: false })
    }
  },

  async createNew(mode = 'chat') {
    const conv = await api.conversation.create(mode)
    await get().refreshList()
    await get().select(conv.id)
    return conv.id
  },

  async select(id) {
    set({ currentId: id })
    await get().hydrateCurrent()
  },

  async hydrateCurrent() {
    const { currentId } = get()
    if (!currentId) {
      set({ messages: [] })
      return
    }
    const { messages } = await api.conversation.get(currentId)
    set({ messages })
  },

  async rename(id, title) {
    await api.conversation.rename(id, title)
    await get().refreshList()
  },

  async remove(id) {
    await api.conversation.remove(id)
    const remain = get().list.filter((c) => c.id !== id)
    if (get().currentId === id) {
      // 删除的是当前会话：自动切到最新一条，没有则回到空状态
      const next = remain[0]?.id ?? null
      set({ currentId: next })
      if (next) await get().hydrateCurrent()
      else set({ messages: [] })
    }
    set({ list: remain })
  },

  reset() {
    set({ currentId: null, messages: [] })
  },

  appendStreaming(messageId, delta) {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + delta } : m
      )
    }))
  }
}))
