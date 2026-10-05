import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/sqlite'
import type {
  AgentStepInfo,
  AgentStepType,
  ConfirmStatus
} from '../../../shared/types'

/**
 * Agent 步骤仓储（agent_step 表）
 *
 * 与 citations 的设计同构：执行过程"事件即时推 UI + 落库可重放"双写。
 * 一次 Agent 回答 = 一条 assistant 消息 + N 行 agent_step（thought/
 * tool_call/observation），消息删除时靠外键 CASCADE 连带清理。
 */

interface StepRow {
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
}

interface InsertStepInput {
  messageId: string
  seq: number
  stepType: AgentStepType
  toolName?: string
  args?: unknown
  result?: string
  confirmId?: string
  confirmStatus?: ConfirmStatus
}

function toStepInfo(r: StepRow): AgentStepInfo {
  const step: AgentStepInfo = {
    id: r.id,
    messageId: r.message_id,
    seq: r.seq,
    stepType: r.step_type as AgentStepType,
    createdAt: r.created_at
  }
  if (r.tool_name) step.toolName = r.tool_name
  if (r.args) {
    // args 损坏不拖垮时间线渲染：原样塞进 result 也不合适，静默丢参数
    try {
      step.args = JSON.parse(r.args)
    } catch {
      step.args = r.args
    }
  }
  if (r.result !== null) step.result = r.result
  if (r.confirm_id) step.confirmId = r.confirm_id
  if (r.confirm_status) step.confirmStatus = r.confirm_status as ConfirmStatus
  return step
}

export function insertStep(input: InsertStepInput): AgentStepInfo {
  const info: AgentStepInfo = {
    id: randomUUID(),
    messageId: input.messageId,
    seq: input.seq,
    stepType: input.stepType,
    createdAt: Date.now()
  }
  if (input.toolName) info.toolName = input.toolName
  if (input.args !== undefined) info.args = input.args
  if (input.result !== undefined) info.result = input.result
  if (input.confirmId) info.confirmId = input.confirmId
  if (input.confirmStatus) info.confirmStatus = input.confirmStatus

  getDb()
    .prepare(
      `INSERT INTO agent_step
         (id, message_id, seq, step_type, tool_name, args, result, confirm_id, confirm_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      info.id,
      info.messageId,
      info.seq,
      info.stepType,
      info.toolName ?? null,
      input.args !== undefined ? JSON.stringify(input.args) : null,
      info.result ?? null,
      info.confirmId ?? null,
      info.confirmStatus ?? null,
      info.createdAt
    )
  return info
}

/** 工具审批结果回写（waiting → approved/denied） */
export function updateStepConfirm(
  stepId: string,
  patch: { confirmId?: string; confirmStatus: ConfirmStatus }
): void {
  getDb()
    .prepare(
      'UPDATE agent_step SET confirm_id = COALESCE(?, confirm_id), confirm_status = ? WHERE id = ?'
    )
    .run(patch.confirmId ?? null, patch.confirmStatus, stepId)
}

/**
 * 一次取回多条消息的步骤（conv:get 聚合用，避免 N+1）。
 * 返回 messageId -> 按 seq 排好的步骤数组。
 */
export function listStepsByMessageIds(
  messageIds: string[]
): Map<string, AgentStepInfo[]> {
  const result = new Map<string, AgentStepInfo[]>()
  if (messageIds.length === 0) return result

  // 参数个数受控（一屏消息有限）；IN 占位符动态拼，值全部参数化绑定
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT * FROM agent_step
       WHERE message_id IN (${placeholders})
       ORDER BY seq ASC, created_at ASC`
    )
    .all(...messageIds) as StepRow[]

  for (const row of rows) {
    const list = result.get(row.message_id) ?? []
    list.push(toStepInfo(row))
    result.set(row.message_id, list)
  }
  return result
}
