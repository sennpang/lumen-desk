import { ipcMain } from 'electron'
import {
  createKb,
  deleteKb,
  ensureDefaultKb,
  getChunk,
  listChunksOfDoc,
  listDocs,
  listKbs
} from '../services/knowledge/repo'
import {
  importDocuments,
  reindexKb,
  removeDocument
} from '../services/rag/indexing'
import { deleteKbIndex } from '../services/rag/vectorStore'
import { getSettings } from '../services/settings/repo'
import { getCloudApiKey } from '../store/secrets'
import type {
  ChunkInfo,
  DocumentInfo,
  KnowledgeBaseInfo
} from '../../shared/types'
import type { KbEvent } from '../../shared/protocol'

/**
 * 知识库 IPC（PRD 13.1 kb:* 频道）
 *
 * kb:import 是"立即返回 + 后台串行 + kb:event 推送"模式，与 chat:run 同构。
 * 导入任务用 Promise 链串行化：embedding 推理与索引写入都不适合并发，
 * 同时也保证多批次导入的事件顺序确定。
 */

// 模块级任务链：每个新导入排到队尾，前序成功失败都继续
let importQueue: Promise<void> = Promise.resolve()
// 在途任务计数：删除知识库不能与导入并发
// （deleteKb 会清表/删索引文件，导入任务正写同一批文件会互相破坏）
let inflightCount = 0

function enqueueImport(task: () => Promise<void>): void {
  inflightCount += 1
  const wrapped = async (): Promise<void> => {
    try {
      await task()
    } finally {
      inflightCount -= 1
    }
  }
  importQueue = importQueue.then(wrapped, wrapped)
}

export function registerKbHandlers(): void {
  ipcMain.handle('kb:list', (): KnowledgeBaseInfo[] => listKbs())

  ipcMain.handle('kb:ensure-default', (): KnowledgeBaseInfo => ensureDefaultKb())

  ipcMain.handle('kb:create', (_e, name: string): KnowledgeBaseInfo =>
    createKb(name)
  )

  // 删除整个知识库：先校验存在与忙状态，再删关系数据（FTS 手动清 +
  // CASCADE 连带 document/chunk），最后删 HNSW 索引/meta 两个文件。
  // 文件清理失败不回滚数据库（已成为无主文件，不影响功能，仅占磁盘）。
  ipcMain.handle('kb:remove', async (_e, kbId: string): Promise<void> => {
    if (typeof kbId !== 'string' || !kbId) throw new Error('知识库 id 无效')
    if (inflightCount > 0) {
      throw new Error('有文档正在导入，请等导入结束后再删除知识库')
    }
    const kb = listKbs().find((k) => k.id === kbId)
    if (!kb) throw new Error('知识库不存在或已被删除')
    deleteKb(kbId)
    await deleteKbIndex(kbId)
  })

  ipcMain.handle('kb:docs', (_e, kbId: string): DocumentInfo[] =>
    listDocs(kbId)
  )

  // 片段预览（知识库页点击文档查看切分效果；上限 500 条防爆量）
  ipcMain.handle('kb:chunks', (_e, docId: string): ChunkInfo[] =>
    listChunksOfDoc(docId, 500)
  )

  // 引用点击：取单个片段原文（联表带 docName）
  ipcMain.handle('kb:chunk', (_e, chunkId: string): ChunkInfo | null =>
    getChunk(chunkId)
  )

  ipcMain.handle(
    'kb:import',
    (event, kbId: string, filePaths: string[]): { queued: boolean } => {
      // 路径来自系统文件对话框（dialog:pickFiles）或 webUtils 拖拽解析，
      // 都是用户显式选择的本地绝对路径；主进程读文件不经过渲染端。
      const target = event.sender
      enqueueImport(async () => {
        const emit = (e: KbEvent) => target.send('kb:event', e)
        try {
          await importDocuments(
            kbId,
            filePaths,
            { settings: getSettings(), cloudApiKey: getCloudApiKey() },
            emit
          )
        } catch (err) {
          // 兜底：importDocuments 内部按文档捕获，这里只防意外（如配置缺失）
          emit({
            type: 'import_finished',
            kbId
          })
          console.error('[kb:import] 导入任务异常：', err)
        }
      })
      return { queued: true }
    }
  )

  ipcMain.handle(
    'kb:reindex',
    async (
      _e,
      kbId: string
    ): Promise<{ docCount: number; chunkCount: number }> => {
      return reindexKb(kbId, {
        settings: getSettings(),
        cloudApiKey: getCloudApiKey()
      })
    }
  )

  ipcMain.handle('kb:remove-doc', async (event, docId: string): Promise<void> => {
    await removeDocument(docId, (e) => event.sender.send('kb:event', e))
  })
}
