import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/sqlite'
import type {
  AgentStepBackup,
  ChatMode,
  CitationRef,
  ConversationBackup,
  ConversationInfo,
  ChatMessage,
  MessageBackup,
  MessageRecord,
  MessageRole,
  MessageSearchHit,
  MessageStatus
} from '../../../shared/types'

/**
 * 会话/消息仓储（PRD 第 12 章 conversation / message 表）
 *
 * 唯一负责"SQL 行 <-> 领域对象"转换的地方：
 * 表用 snake_case + INTEGER 时间戳，TS 用 camelCase，转换集中在此，
 * 上层 IPC/UI 不感知数据库列名。
 */

interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  mode: string
  model_id: string | null
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  status: string
  tokens: number | null
  created_at: number
  seq: number
  meta: string | null
}

function toConversationInfo(r: ConversationRow): ConversationInfo {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mode: r.mode as ChatMode,
    modelId: r.model_id
  }
}

function toMessageRecord(r: MessageRow): MessageRecord {
  const record: MessageRecord = {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as MessageRole,
    content: r.content,
    status: r.status as MessageStatus,
    tokens: r.tokens,
    createdAt: r.created_at,
    seq: r.seq
  }
  // meta 目前只装 citations；未来扩展继续往这个 JSON 里加字段
  if (r.meta) {
    try {
      const parsed = JSON.parse(r.meta) as { citations?: CitationRef[] }
      if (Array.isArray(parsed.citations)) record.citations = parsed.citations
    } catch {
      // 损坏的 meta 不应影响消息读取
    }
  }
  return record
}

export function createConversation(mode: ChatMode, modelId: string | null): ConversationInfo {
  const now = Date.now()
  const info: ConversationInfo = {
    id: randomUUID(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    mode,
    modelId
  }
  getDb()
    .prepare(
      `INSERT INTO conversation(id, title, created_at, updated_at, mode, model_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(info.id, info.title, now, now, mode, modelId)
  return info
}

export function listConversations(): ConversationInfo[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversation ORDER BY updated_at DESC')
    .all() as ConversationRow[]
  return rows.map(toConversationInfo)
}

export function getConversation(id: string): ConversationInfo | null {
  const row = getDb()
    .prepare('SELECT * FROM conversation WHERE id = ?')
    .get(id) as ConversationRow | undefined
  return row ? toConversationInfo(row) : null
}

export function renameConversation(id: string, title: string): void {
  getDb()
    .prepare('UPDATE conversation SET title = ?, updated_at = ? WHERE id = ?')
    .run(title.trim(), Date.now(), id)
}

export function deleteConversation(id: string): void {
  // message 行靠 ON DELETE CASCADE 自动清理（前提：PRAGMA foreign_keys=ON）
  getDb().prepare('DELETE FROM conversation WHERE id = ?').run(id)
}

export function touchConversation(id: string, modelId?: string | null): void {
  getDb()
    .prepare(
      `UPDATE conversation
       SET updated_at = ?, model_id = COALESCE(?, model_id)
       WHERE id = ?`
    )
    .run(Date.now(), modelId ?? null, id)
}

/** 首条用户消息发出后，用消息内容前若干字作为会话标题 */
export function autoTitleFromFirstMessage(id: string, content: string): void {
  const title = content.replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话'
  getDb().prepare('UPDATE conversation SET title = ? WHERE id = ?').run(title, id)
}

// ---------------- message ----------------

function nextSeq(conversationId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message WHERE conversation_id = ?')
    .get(conversationId) as { next: number }
  return row.next
}

export interface AddMessageInput {
  conversationId: string
  role: MessageRole
  content: string
  status?: MessageStatus
  tokens?: number | null
  citations?: CitationRef[]
}

export function addMessage(input: AddMessageInput): MessageRecord {
  const db = getDb()
  const record: MessageRecord = {
    id: randomUUID(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    status: input.status ?? 'done',
    tokens: input.tokens ?? null,
    createdAt: Date.now(),
    seq: 0, // 下方事务内赋值
    citations: input.citations
  }

  // 事务保证"取最大序号 + 插入"原子，并发写入也不会撞 UNIQUE(conversation_id, seq)
  const tx = db.transaction(() => {
    record.seq = nextSeq(input.conversationId)
    db.prepare(
      `INSERT INTO message(id, conversation_id, role, content, status, tokens, created_at, seq, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.conversationId,
      record.role,
      record.content,
      record.status,
      record.tokens,
      record.createdAt,
      record.seq,
      input.citations ? JSON.stringify({ citations: input.citations }) : null
    )
  })
  tx()
  return record
}

export function updateMessage(
  id: string,
  patch: {
    content?: string
    status?: MessageStatus
    tokens?: number | null
    citations?: CitationRef[]
  }
): void {
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.content !== undefined) {
    fields.push('content = ?')
    values.push(patch.content)
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    values.push(patch.status)
  }
  if (patch.tokens !== undefined) {
    fields.push('tokens = ?')
    values.push(patch.tokens)
  }
  if (patch.citations !== undefined) {
    fields.push('meta = ?')
    values.push(JSON.stringify({ citations: patch.citations }))
  }
  if (fields.length === 0) return
  values.push(id)
  getDb()
    .prepare(`UPDATE message SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values)
}

export function listMessages(conversationId: string): MessageRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as MessageRow[]
  return rows.map(toMessageRecord)
}

/**
 * 历史消息搜索（会话多了之后靠 24 字标题找不到内容）。
 *
 * 本地单用户消息量（几千到几万行）下 LIKE '%q%' 全表扫描是毫秒级，
 * 不值得为它再维护一张消息 FTS 虚表（要补触发器/迁移/删除同步）；
 * 中文子串匹配 LIKE 天然支持（与 chunk_fts 用 trigram 的场景不同：
 * 知识库 chunk 量大且要参与排序融合）。
 * 用户输入里的 % _ \ 必须转义，否则会被当通配符。
 */
const SEARCH_LIMIT = 50
const SNIPPET_RADIUS = 36

export function searchMessages(rawQuery: string): MessageSearchHit[] {
  const query = rawQuery.trim()
  if (!query) return []
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`)
  const rows = getDb()
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, m.role, m.content,
              m.created_at, c.title AS conversation_title
         FROM message m
         JOIN conversation c ON c.id = m.conversation_id
        WHERE m.content LIKE ? ESCAPE '\\'
          AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC
        LIMIT ?`
    )
    .all(`%${escaped}%`, SEARCH_LIMIT) as Array<{
    message_id: string
    conversation_id: string
    role: string
    content: string
    created_at: number
    conversation_title: string
  }>

  const lowerQuery = query.toLowerCase()
  return rows.map((r) => {
    const idx = r.content.toLowerCase().indexOf(lowerQuery)
    const start = Math.max(0, idx - SNIPPET_RADIUS)
    const end = Math.min(r.content.length, idx + query.length + SNIPPET_RADIUS)
    const snippet =
      (start > 0 ? '…' : '') +
      r.content.slice(start, end).replace(/\s+/g, ' ').trim() +
      (end < r.content.length ? '…' : '')
    return {
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      messageId: r.message_id,
      role: r.role as MessageRole,
      snippet,
      createdAt: r.created_at
    }
  })
}

/** 组装发给 LLM 的上下文（只要 user/assistant/system 的已完成文本，tool 角色 M5 再加） */
export function buildChatHistory(conversationId: string): ChatMessage[] {
  return listMessages(conversationId)
    .filter((m) => m.status === 'done' && m.role !== 'tool')
    .map((m) => ({ role: m.role, content: m.content }))
}

// ---------------- 全量备份导出 / 导入 ----------------

/**
 * 一次性导出全部会话（消息 + Agent 步骤）。
 * 三条 SELECT 拼内存结构，避免每会话/每消息 N+1。
 */
export function exportConversationsForBackup(): ConversationBackup[] {
  const db = getDb()
  const convRows = db
    .prepare('SELECT * FROM conversation ORDER BY created_at')
    .all() as ConversationRow[]
  const msgRows = db
    .prepare('SELECT * FROM message ORDER BY conversation_id, seq')
    .all() as MessageRow[]
  const stepRows = db
    .prepare('SELECT * FROM agent_step ORDER BY message_id, seq')
    .all() as Array<{
    id: string
    message_id: string
    seq: number
    step_type: string
    tool_name: string | null
    args: string | null
    result: string | null
    confirm_id: string | null
    confirm_status: string | null
    created_at: number
  }>

  const stepsByMsg = new Map<string, AgentStepBackup[]>()
  for (const s of stepRows) {
    const list = stepsByMsg.get(s.message_id) ?? []
    list.push({
      id: s.id,
      seq: s.seq,
      stepType: s.step_type,
      toolName: s.tool_name,
      args: s.args,
      result: s.result,
      confirmId: s.confirm_id,
      confirmStatus: s.confirm_status,
      createdAt: s.created_at
    })
    stepsByMsg.set(s.message_id, list)
  }

  const msgsByConv = new Map<string, MessageBackup[]>()
  for (const m of msgRows) {
    const list = msgsByConv.get(m.conversation_id) ?? []
    list.push({
      id: m.id,
      role: m.role,
      content: m.content,
      status: m.status,
      tokens: m.tokens,
      createdAt: m.created_at,
      seq: m.seq,
      meta: m.meta,
      agentSteps: stepsByMsg.get(m.id) ?? []
    })
    msgsByConv.set(m.conversation_id, list)
  }

  return convRows.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    mode: c.mode as ChatMode,
    modelId: c.model_id,
    messages: msgsByConv.get(c.id) ?? []
  }))
}

/**
 * 导回一个会话（保留原 id：消息 meta 里的 RAG citation 指向备份内同 id
 * 的 chunk，重新生成 id 会让引用全部失效）。
 * @returns true=已导入；false=同 id 会话已存在，整组跳过（重复导入/合并场景）
 */
export function importConversationBackup(c: ConversationBackup): boolean {
  const db = getDb()
  const exists = db
    .prepare('SELECT id FROM conversation WHERE id = ?')
    .get(c.id) as { id: string } | undefined
  if (exists) return false

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO conversation(id, title, created_at, updated_at, mode, model_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(c.id, c.title, c.createdAt, c.updatedAt, c.mode, c.modelId)

    const insertMsg = db.prepare(
      `INSERT INTO message(id, conversation_id, role, content, status, tokens, created_at, seq, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertStep = db.prepare(
      `INSERT INTO agent_step
         (id, message_id, seq, step_type, tool_name, args, result, confirm_id, confirm_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const m of c.messages) {
      insertMsg.run(
        m.id,
        c.id,
        m.role,
        m.content,
        m.status,
        m.tokens,
        m.createdAt,
        m.seq,
        m.meta
      )
      for (const s of m.agentSteps) {
        insertStep.run(
          s.id,
          m.id,
          s.seq,
          s.stepType,
          s.toolName,
          s.args,
          s.result,
          s.confirmId,
          s.confirmStatus,
          s.createdAt
        )
      }
    }
  })
  tx()
  return true
}

/** 重新生成：取会话中最后一条用户消息（作为重发的内容） */
export function getLastUserMessage(conversationId: string): MessageRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM message
       WHERE conversation_id = ? AND role = 'user'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(conversationId) as MessageRow | undefined
  return row ? toMessageRecord(row) : null
}

/**
 * 重新生成：删掉会话末尾的 assistant 消息（连带其 agent_step 由
 * ON DELETE CASCADE 清除，meta 里的 citations 随行删除）。
 * 只删"末尾"那条——若最后一条是 user（崩溃残留）则不动数据。
 * @returns 被删除的消息，没有可删的时返回 null
 */
export function deleteTrailingAssistant(conversationId: string): MessageRecord | null {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT * FROM message WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1'
    )
    .get(conversationId) as MessageRow | undefined
  if (!row || row.role !== 'assistant') return null
  const record = toMessageRecord(row)
  db.prepare('DELETE FROM message WHERE id = ?').run(row.id)
  return record
}
