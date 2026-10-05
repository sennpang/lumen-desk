/**
 * 统一流式事件协议（PRD 13.2）
 *
 * 所有运行时信息——普通 token / RAG 引用 / Agent 步骤 / 确认请求——
 * 都通过同一个 IPC 频道 'chat:event' 下行，用 type 区分，
 * 渲染端只需要一个订阅入口 + 一个 reducer 处理。
 *
 * 与 PRD 的一处增强：每个事件都带 streamId（PRD 只在 start 上标注）。
 * 原因：未来支持多窗口/并发运行时，渲染端靠 streamId 过滤属于自己的事件流，
 * 成本几乎为零，提前把协议设计对。
 */
import type { ChatMode } from './types'

/** chat:run 入参 */
export interface RunPayload {
  /** 不传则由主进程新建会话（F-A3） */
  conversationId?: string
  mode: ChatMode
  /** 用户这一轮输入的文本 */
  message: string
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
}

export type StreamEvent =
  | { type: 'start'; streamId: string; conversationId: string; messageId: string }
  | { type: 'token'; streamId: string; delta: string }
  | {
      type: 'citation'
      streamId: string
      chunkId: string
      docName: string
      snippet: string
    }
  | {
      type: 'agent_step'
      streamId: string
      stepType: 'thought' | 'tool_call' | 'observation'
      toolName?: string
      args?: unknown
      result?: string
    }
  | {
      type: 'confirm_required'
      streamId: string
      confirmId: string
      toolName: string
      args: unknown
      preview: string
    }
  | { type: 'error'; streamId: string; message: string }
  | { type: 'done'; streamId: string; usage: UsageInfo | null }
