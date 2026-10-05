import { promises as fs } from 'node:fs'
import { BrowserWindow, dialog, shell } from 'electron'
import type { ToolSchema } from '../llm/client'
import { retrieve } from '../rag/retriever'
import type { EmbeddingDeps } from '../rag/embedder'

/**
 * Agent 工具集（M5）
 *
 * 风险分级（PRD F-A4"外部副作用需用户确认"）：
 * - 只读工具（知识库检索 / 时间）：模型可自动执行，结果作为 observation 回灌
 * - 有外部副作用的工具（打开链接 / 写本地文件）：requiresConfirm=true，
 *   runner 先发 confirm_required 挂起循环，用户批准后才真正 execute
 *
 * 每个工具三件事：JSON Schema（给模型看的契约）、preview（给人看的
 * 确认摘要）、execute（主进程真实动作）。工具对模型只暴露字符串 in/out，
 * 参数异常永远返回结构化文本而非抛异常抛穿 Agent 循环。
 */

export interface ToolExecutionContext {
  /** 本轮 Agent 会话绑定的知识库（Composer 选择，检索工具的默认库） */
  kbId?: string
  embedding: EmbeddingDeps
}

export interface ToolExecResult {
  /** false = 业务级失败（参数错/检索失败），文本会作为 observation 让模型自我纠正 */
  ok: boolean
  output: string
}

export interface ToolDefinition {
  schema: ToolSchema
  /** true 时执行前必须经过用户确认 */
  requiresConfirm: boolean
  /** 确认卡片/时间线给用户看的一句话摘要（禁止把完整参数裸贴） */
  preview(args: unknown): string
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecResult>
}

// ---------------- 工具实现 ----------------

/** 单条检索结果注入回模型时的最大长度，控制 observation 的 token 体积 */
const RESULT_TEXT_LIMIT = 600
const MAX_TOP_K = 10

const searchKnowledgeBase: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description:
        '在本地知识库中检索资料。当用户的问题可能需要查阅已导入的文档、制度、笔记时调用，可多次调用检索不同关键词。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或问题（中文 2 字以内请换更具体的措辞）'
          },
          kb_id: {
            type: 'string',
            description: '目标知识库 id；不传则使用当前会话绑定的知识库'
          },
          top_k: {
            type: 'integer',
            description: '返回结果数量，默认 5，最多 10'
          }
        },
        required: ['query']
      }
    }
  },
  requiresConfirm: false,
  preview(args) {
    const a = args as { query?: unknown }
    return `检索知识库：${typeof a.query === 'string' ? a.query : '?'}`
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return { ok: false, output: '参数错误：query 必须是非空字符串' }
    const kbId =
      (typeof args.kb_id === 'string' && args.kb_id) || ctx.kbId
    if (!kbId) {
      return {
        ok: false,
        output: '当前未绑定知识库，且参数未提供 kb_id，无法检索。'
      }
    }
    const rawTopK = typeof args.top_k === 'number' ? Math.trunc(args.top_k) : 5
    const topK = Math.min(MAX_TOP_K, Math.max(1, Number.isFinite(rawTopK) ? rawTopK : 5))

    const chunks = await retrieve(query, kbId, ctx.embedding, topK)
    if (chunks.length === 0) {
      return { ok: true, output: JSON.stringify({ results: [] }) + '\n（知识库中没有检索到相关片段，可换关键词重试或如实告知用户）' }
    }
    const results = chunks.map((c) => ({
      doc_name: c.docName ?? '未命名文档',
      page: typeof c.meta.page === 'number' ? c.meta.page : null,
      content:
        c.content.length > RESULT_TEXT_LIMIT
          ? c.content.slice(0, RESULT_TEXT_LIMIT) + '…'
          : c.content
    }))
    return { ok: true, output: JSON.stringify({ results }, null, 2) }
  }
}

const getCurrentDatetime: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: '获取当前的日期、时间与星期（用户询问"今天/现在/几点"等时间相关问题时使用），无参数。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  requiresConfirm: false,
  preview: () => '获取当前日期时间',
  async execute() {
    const now = new Date()
    return {
      ok: true,
      output: JSON.stringify({
        iso: now.toISOString(),
        local: now.toLocaleString('zh-CN', { hour12: false }),
        weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()],
        unix_ms: now.getTime()
      })
    }
  }
}

const openUrl: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在用户的默认浏览器中打开一个 http/https 网页链接（需要用户确认）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的完整网址，必须以 http:// 或 https:// 开头' }
        },
        required: ['url']
      }
    }
  },
  requiresConfirm: true,
  preview(args) {
    const a = args as { url?: unknown }
    return `在浏览器中打开：${typeof a.url === 'string' ? a.url : '?'}`
  },
  async execute(args) {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    // 白名单协议：杜绝 file:// / smb:// / javascript: 等借系统默认程序逃逸
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, output: `不安全或不支持的 URL（仅允许 http/https）：${url}` }
    }
    await shell.openExternal(url)
    return { ok: true, output: `已在默认浏览器打开：${url}` }
  }
}

const saveNote: ToolDefinition = {
  schema: {
    type: 'function',
    function: {
      name: 'save_note',
      description:
        '把一段文本保存为本地文件（.md/.txt）。会弹出系统保存对话框由用户选择位置，需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '建议的文件名（含扩展名），如 会议纪要.md' },
          content: { type: 'string', description: '要写入的完整文本内容' }
        },
        required: ['filename', 'content']
      }
    }
  },
  requiresConfirm: true,
  preview(args) {
    const a = args as { filename?: unknown; content?: unknown }
    const len = typeof a.content === 'string' ? a.content.length : 0
    return `保存笔记 ${typeof a.filename === 'string' ? `「${a.filename}」` : ''}（约 ${len} 字）到你选择的位置`
  },
  async execute(args) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!filename || !content) {
      return { ok: false, output: '参数错误：filename 与 content 均不能为空' }
    }
    // 文件名只取 basename：模型可能给出路径形式，保存位置必须由对话框决定
    const safeName = filename.replace(/[/\\]/g, '_')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: '保存笔记',
      defaultPath: safeName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) {
      // 取消不是工具失败：让模型如实告诉用户未保存
      return { ok: true, output: '用户取消了保存，文件未写入。' }
    }
    await fs.writeFile(result.filePath, content, 'utf8')
    return { ok: true, output: `已保存到：${result.filePath}` }
  }
}

// ---------------- 注册表 ----------------

const REGISTRY = new Map<string, ToolDefinition>(
  [searchKnowledgeBase, getCurrentDatetime, openUrl, saveNote].map((t) => [
    t.schema.function.name,
    t
  ])
)

export function getTool(name: string): ToolDefinition | undefined {
  return REGISTRY.get(name)
}

/** 按稳定顺序给模型的工具声明（顺序也影响小模型的选择倾向：高频只读在前） */
export const TOOL_SCHEMAS: ToolSchema[] = [
  searchKnowledgeBase.schema,
  getCurrentDatetime.schema,
  openUrl.schema,
  saveNote.schema
]
