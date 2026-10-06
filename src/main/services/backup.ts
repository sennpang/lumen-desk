import { getDb } from '../db/sqlite'
import {
  exportConversationsForBackup,
  importConversationBackup
} from './conversations/repo'
import { exportKbsForBackup, importKbBackup } from './knowledge/repo'
import type {
  AgentStepBackup,
  ChatMode,
  ChunkBackup,
  ConversationBackup,
  DataBackup,
  DataImportResult,
  DocumentBackup,
  KbBackup,
  MessageBackup
} from '../../shared/types'

/**
 * 全量数据备份编排（换电脑/重装时迁移会话与知识库文本）。
 *
 * 边界（与设置备份一致的安全模型）：
 * - 只含关系数据：会话/消息/Agent 步骤、知识库/文档/片段文本（含 FTS 源）
 * - 不含向量索引（HNSW 文件）：导入后在知识库页点一次"重建索引"即可
 * - 不含任何密钥（API Key 在系统 Keychain/DPAPI，跨机器无法解密）
 * - id 全部保留：消息 meta 里的 RAG citation 按 chunkId 引用片段，
 *   重新生成 id 会让历史回答的来源全部失联；同 id 已存在则整组跳过
 */

export function buildDataBackup(appVersion: string): DataBackup {
  return {
    kind: 'lumen-desk-data',
    appVersion,
    exportedAt: Date.now(),
    conversations: exportConversationsForBackup(),
    knowledgeBases: exportKbsForBackup()
  }
}

// ---------------- 结构校验（备份文件来自外部，不能信任任何字段） ----------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const MODES: ChatMode[] = ['chat', 'rag', 'agent']

function sanitizeConversation(raw: unknown): ConversationBackup | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const messages: MessageBackup[] = []
  const rawMsgs = Array.isArray(raw.messages) ? raw.messages : []
  for (const rm of rawMsgs) {
    if (!isObj(rm) || typeof rm.id !== 'string' || !rm.id) continue
    const role = ['user', 'assistant', 'tool', 'system'].includes(String(rm.role))
      ? String(rm.role)
      : 'assistant'
    const status = ['streaming', 'done', 'error'].includes(String(rm.status))
      ? String(rm.status)
      : 'done'
    const steps: AgentStepBackup[] = []
    const rawSteps = Array.isArray(rm.agentSteps) ? rm.agentSteps : []
    for (const rs of rawSteps) {
      if (!isObj(rs) || typeof rs.id !== 'string' || !rs.id) continue
      const stepType = ['thought', 'tool_call', 'observation'].includes(
        String(rs.stepType)
      )
        ? String(rs.stepType)
        : 'observation'
      steps.push({
        id: rs.id,
        seq: num(rs.seq),
        stepType,
        toolName: strOrNull(rs.toolName),
        args: strOrNull(rs.args),
        result: strOrNull(rs.result),
        confirmId: strOrNull(rs.confirmId),
        confirmStatus: strOrNull(rs.confirmStatus),
        createdAt: num(rs.createdAt)
      })
    }
    messages.push({
      id: rm.id,
      role,
      content: str(rm.content),
      status,
      tokens: numOrNull(rm.tokens),
      createdAt: num(rm.createdAt),
      seq: num(rm.seq),
      meta: strOrNull(rm.meta),
      agentSteps: steps
    })
  }
  return {
    id: raw.id,
    title: str(raw.title, '未命名对话'),
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    mode: MODES.includes(raw.mode as ChatMode) ? (raw.mode as ChatMode) : 'chat',
    modelId: strOrNull(raw.modelId),
    messages
  }
}

function sanitizeKb(raw: unknown): KbBackup | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const documents: DocumentBackup[] = []
  const rawDocs = Array.isArray(raw.documents) ? raw.documents : []
  for (const rd of rawDocs) {
    if (!isObj(rd) || typeof rd.id !== 'string' || !rd.id) continue
    const chunks: ChunkBackup[] = []
    const rawChunks = Array.isArray(rd.chunks) ? rd.chunks : []
    for (const rc of rawChunks) {
      if (!isObj(rc) || typeof rc.id !== 'string' || !rc.id) continue
      chunks.push({
        id: rc.id,
        chunkIndex: num(rc.chunkIndex),
        content: str(rc.content),
        tokenCount: numOrNull(rc.tokenCount),
        meta: strOrNull(rc.meta)
      })
    }
    const status = ['parsing', 'ready', 'failed'].includes(String(rd.status))
      ? String(rd.status)
      : 'ready'
    documents.push({
      id: rd.id,
      fileName: str(rd.fileName, '未命名文档'),
      fileHash: strOrNull(rd.fileHash),
      status,
      chunkCount: num(rd.chunkCount),
      error: strOrNull(rd.error),
      createdAt: num(rd.createdAt),
      chunks
    })
  }
  return {
    id: raw.id,
    name: str(raw.name, '未命名知识库'),
    createdAt: num(raw.createdAt),
    documents
  }
}

/**
 * 从备份对象恢复数据。整个导入包在一个大事务里：任一行写入失败
 * （磁盘满/约束冲突）全部回滚，不会留下导了一半的状态。
 */
export function restoreDataBackup(input: unknown): DataImportResult {
  if (!isObj(input) || input.kind !== 'lumen-desk-data') {
    throw new Error('这不是 Lumen Desk 的数据备份文件（缺少 kind 标识）。')
  }

  const conversations = (Array.isArray(input.conversations) ? input.conversations : [])
    .map(sanitizeConversation)
    .filter((c): c is ConversationBackup => c !== null)
  const kbs = (Array.isArray(input.knowledgeBases) ? input.knowledgeBases : [])
    .map(sanitizeKb)
    .filter((k): k is KbBackup => k !== null)

  const result: DataImportResult = {
    conversations: { imported: 0, skipped: 0 },
    knowledgeBases: { imported: 0, skipped: 0, documents: 0, chunks: 0 },
    reindexKbIds: []
  }

  const tx = getDb().transaction(() => {
    for (const c of conversations) {
      if (importConversationBackup(c)) result.conversations.imported += 1
      else result.conversations.skipped += 1
    }
    for (const kb of kbs) {
      const r = importKbBackup(kb)
      if (!r) {
        result.knowledgeBases.skipped += 1
        continue
      }
      result.knowledgeBases.imported += 1
      result.knowledgeBases.documents += r.documents
      result.knowledgeBases.chunks += r.chunks
      if (r.chunks > 0) result.reindexKbIds.push(kb.id)
    }
  })
  tx()

  return result
}
