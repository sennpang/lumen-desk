import { create } from 'zustand'
import { api } from '../lib/ipc'
import type { DocumentInfo, KnowledgeBaseInfo } from '../../../shared/types'
import type { KbEvent } from '../../../shared/protocol'

/**
 * 知识库状态（M3 F-C1/C2）：库列表、当前库、文档卡片三态。
 *
 * 与会话 store 同构的"事件驱动"模型：kb:import 立即返回，
 * 导入过程由 kb:event 增量驱动——卡片先出现 parsing，
 * doc_result 再变 ready/failed；import_finished 以库为准整体回填
 * （chunkCount / docCount 这种聚合字段不自己算）。
 */
interface KnowledgeState {
  kbs: KnowledgeBaseInfo[]
  currentKbId: string | null
  docs: DocumentInfo[]
  loading: boolean
  /** 有导入任务在后台进行（禁用导入按钮） */
  importing: boolean
  /** 操作级错误（导入/删除/重建），渲染为横幅 */
  error: string | null

  init: () => Promise<void>
  refreshKbs: () => Promise<void>
  refreshDocs: () => Promise<void>
  selectKb: (id: string) => Promise<void>
  createKb: (name: string) => Promise<void>
  /** 系统文件选择框导入 */
  pickAndImport: () => Promise<void>
  /** 拖拽导入：drop 后由组件用 webUtils 解析出的绝对路径 */
  importPaths: (paths: string[]) => Promise<void>
  removeDoc: (docId: string) => Promise<void>
  reindex: () => Promise<void>
  handleKbEvent: (ev: KbEvent) => Promise<void>
  clearError: () => void
}

export const useKnowledge = create<KnowledgeState>((set, get) => ({
  kbs: [],
  currentKbId: null,
  docs: [],
  loading: false,
  importing: false,
  error: null,

  async init() {
    set({ loading: true })
    try {
      // 默认库幂等：首次使用自动建好，聊天区 RAG 开关也依赖它存在
      const defaultKb = await api.knowledge.ensureDefaultKb()
      const kbs = await api.knowledge.listKbs()
      // 保留用户已选的库（若还存在），否则落默认库
      const stillExists = get().currentKbId && kbs.some((k) => k.id === get().currentKbId)
      const currentKbId = stillExists ? (get().currentKbId as string) : defaultKb.id
      const docs = await api.knowledge.listDocs(currentKbId)
      set({ kbs, currentKbId, docs })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async refreshKbs() {
    const kbs = await api.knowledge.listKbs()
    set({ kbs })
  },

  async refreshDocs() {
    const { currentKbId } = get()
    if (!currentKbId) return
    const docs = await api.knowledge.listDocs(currentKbId)
    set({ docs })
  },

  async selectKb(id) {
    if (id === get().currentKbId) return
    set({ currentKbId: id, loading: true })
    try {
      set({ docs: await api.knowledge.listDocs(id) })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async createKb(name) {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const kb = await api.knowledge.createKb(trimmed)
      await get().refreshKbs()
      await get().selectKb(kb.id)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  async pickAndImport() {
    try {
      const paths = await api.dialog.pickFiles()
      if (paths.length > 0) await get().importPaths(paths)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  async importPaths(paths) {
    const { currentKbId, importing } = get()
    if (!currentKbId || importing || paths.length === 0) return
    // importing 在 import_finished 事件里复位（主进程保证该事件必发）
    set({ importing: true, error: null })
    try {
      await api.knowledge.importFiles(currentKbId, paths)
    } catch (e) {
      set({ importing: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  async removeDoc(docId) {
    try {
      // 乐观移除；doc_removed 事件还会再确认一次
      set({ docs: get().docs.filter((d) => d.id !== docId) })
      await api.knowledge.removeDoc(docId)
      await get().refreshKbs()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      await get().refreshDocs()
    }
  },

  async reindex() {
    const { currentKbId, importing } = get()
    if (!currentKbId || importing) return
    set({ importing: true, error: null })
    try {
      // reindex 是 await 到完成的调用（文档少时几秒），期间禁用导入
      await api.knowledge.reindex(currentKbId)
      await get().refreshDocs()
    } catch (e) {
      set({ error: `重建索引失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      set({ importing: false })
    }
  },

  async handleKbEvent(ev) {
    // 后台事件可能来自别的库（理论上当前只有默认库交互，仍显式过滤）
    if (ev.kbId !== get().currentKbId) return
    switch (ev.type) {
      case 'doc_enqueued': {
        // 立即插入 parsing 卡片：即便后续解析失败，用户也看到"处理过这个文件"
        const card: DocumentInfo = {
          id: ev.docId,
          kbId: ev.kbId,
          fileName: ev.fileName,
          fileHash: null,
          status: ev.status,
          chunkCount: ev.chunkCount,
          createdAt: ev.createdAt,
          error: null
        }
        set((s) =>
          s.docs.some((d) => d.id === card.id)
            ? s
            : { docs: [card, ...s.docs] }
        )
        break
      }
      case 'doc_result': {
        set((s) => ({
          docs: s.docs.map((d) =>
            d.id === ev.docId
              ? {
                  ...d,
                  status: ev.status,
                  chunkCount: ev.chunkCount ?? d.chunkCount,
                  error: ev.error ?? null
                }
              : d
          )
        }))
        break
      }
      case 'doc_removed': {
        set((s) => ({ docs: s.docs.filter((d) => d.id !== ev.docId) }))
        await get().refreshKbs()
        break
      }
      case 'import_finished': {
        // 以数据库为准回填（聚合字段/去重跳过的文件），再更新库计数
        set({ importing: false })
        await Promise.all([get().refreshDocs(), get().refreshKbs()])
        break
      }
    }
  },

  clearError() {
    set({ error: null })
  }
}))
