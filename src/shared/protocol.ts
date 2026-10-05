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
import type { ChatMode, DocStatus } from './types'

/** chat:run 入参 */
export interface RunPayload {
  /** 不传则由主进程新建会话（F-A3） */
  conversationId?: string
  mode: ChatMode
  /** 用户这一轮输入的文本 */
  message: string
  /** mode='rag' 时必填：要检索的知识库 id */
  kbId?: string
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
      /** PDF 页码（从 1 起）；docx/md/txt 为 null */
      page: number | null
    }
  | {
      type: 'agent_step'
      streamId: string
      /** 步骤在本次回答内的序号（0 起），也是渲染端去重/排序键 */
      seq: number
      /** agent_step 表行 id（切换会话后 hydrate 用它对齐） */
      stepId: string
      stepType: 'thought' | 'tool_call' | 'observation'
      toolName?: string
      args?: unknown
      result?: string
      /** tool_call 步骤的审批状态；仅需确认工具出现 */
      confirmStatus?: 'waiting' | 'approved' | 'denied'
    }
  | {
      type: 'confirm_required'
      streamId: string
      confirmId: string
      /** 对应 agent_step(tool_call) 的行 id，确认卡片挂到该时间线节点 */
      stepId: string
      toolName: string
      args: unknown
      preview: string
    }
  | { type: 'error'; streamId: string; message: string }
  | { type: 'done'; streamId: string; usage: UsageInfo | null }

/**
 * 知识库后台任务事件（kb:event）。
 *
 * 设计原因（PRD F-C1"显示导入进度、解析状态与失败原因"）：
 * 导入是秒级到分钟级的后台任务（解析→切分→逐个 embed→写 HNSW），
 * invoke 同步等待会让渲染端失去过程可见性。所以 kb:import 立即返回，
 * 主进程串行处理、按生命周期推事件，渲染端增量更新文档卡片。
 */
export type KbEvent =
  /** 文档入库、进入解析队列 */
  | {
      type: 'doc_enqueued'
      kbId: string
      docId: string
      fileName: string
      status: DocStatus
      chunkCount: number
      createdAt: number
    }
  /** 单文档处理结束（ready 带 chunkCount，failed 带 error） */
  | {
      type: 'doc_result'
      kbId: string
      docId: string
      status: DocStatus
      chunkCount?: number
      error?: string
    }
  /** 文档被删除 */
  | { type: 'doc_removed'; kbId: string; docId: string }
  /** 整批导入结束（无论全部成功还是部分失败） */
  | { type: 'import_finished'; kbId: string }
