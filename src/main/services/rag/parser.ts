import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import type { DocFormat, ParsedBlock, ParsedDoc } from './types'

/**
 * 文档解析器（PRD F-C1：PDF/DOCX/Markdown/TXT）
 *
 * 统一出口 parseDocument：按扩展名分发到四个格式解析器，
 * 输出 ParsedBlock 序列交给 chunker。
 *
 * 依赖加载策略：
 * - mammoth 是 CJS，静态 import 即可
 * - pdfjs-dist 是 ESM 且体量较大，仅解析 PDF 时动态 await import()，
 *   不解析 PDF 的导入不付出加载成本（Node 24 下 import ESM 无兼容问题）
 */

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  '.txt'
])

export function detectFormat(fileName: string): DocFormat {
  const ext = path.extname(fileName).toLowerCase()
  switch (ext) {
    case '.pdf':
      return 'pdf'
    case '.docx':
      return 'docx'
    case '.md':
    case '.markdown':
      return 'md'
    case '.txt':
      return 'txt'
    default:
      throw new Error(
        `不支持的文件格式：${ext || '（无扩展名）'}。仅支持 PDF / DOCX / Markdown / TXT。`
      )
  }
}

export async function parseDocument(filePath: string): Promise<ParsedDoc> {
  const format = detectFormat(filePath)
  const buffer = await readFile(filePath)

  switch (format) {
    case 'pdf':
      return { format, blocks: await parsePdf(buffer) }
    case 'docx':
      return { format, blocks: await parseDocx(buffer) }
    case 'md':
      return { format, blocks: parseMarkdown(buffer.toString('utf-8')) }
    case 'txt':
      return { format, blocks: parsePlainText(buffer.toString('utf-8')) }
  }
}

// ---------------- TXT ----------------

/**
 * 纯文本：空行分段，段内换行保留（硬换行是 TXT 排版的一部分）。
 */
function parsePlainText(raw: string): ParsedBlock[] {
  return groupLinesIntoParagraphs(
    raw.split(/\r?\n/),
    () => null
  )
}

// ---------------- Markdown ----------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/**
 * Markdown：识别 ATX 标题（# … ######），代码围栏内容整体作为
 * 一个段落（代码里的 # 不是标题，不能误切）。
 */
function parseMarkdown(raw: string): ParsedBlock[] {
  const lines = raw.split(/\r?\n/)
  const blocks: ParsedBlock[] = []
  let buffer: string[] = []
  let inFence = false
  let fenceMarker = ''

  const flush = () => {
    if (buffer.length > 0) {
      const text = buffer.join('\n').trim()
      if (text) blocks.push({ kind: 'paragraph', text, page: null })
      buffer = []
    }
  }

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2][0]
      if (!inFence) {
        flush()
        inFence = true
        fenceMarker = marker
        buffer.push(line)
        continue
      }
      if (marker === fenceMarker) {
        buffer.push(line)
        flush()
        inFence = false
        fenceMarker = ''
        continue
      }
    }

    if (inFence) {
      buffer.push(line)
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flush()
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2].trim()
      })
    } else {
      buffer.push(line)
      // 空行是段落边界，立即 flush，避免把上下两节并成一段
      if (line.trim() === '') flush()
    }
  }
  flush()
  return blocks
}

// ---------------- DOCX ----------------

/**
 * DOCX：mammoth 抽取纯文本，每个 Word 段落对应输出一行（\n 分隔）。
 * docx 流式排版没有固定分页，page 一律 null。
 */
async function parseDocx(buffer: Buffer): Promise<ParsedBlock[]> {
  const result = await mammoth.extractRawText({ buffer })
  // mammoth 的 messages 主要是样式降级提示（如图片无法转文本），
  // 不影响文本抽取结果，这里不致命——记录到结果末尾也无意义，忽略。
  void result.messages
  return groupLinesIntoParagraphs(result.value.split(/\r?\n/), () => null)
}

// ---------------- PDF ----------------

async function parsePdf(buffer: Buffer): Promise<ParsedBlock[]> {
  // 动态加载：pdfjs-dist 的 Node legacy 构建（ESM）。
  // useSystemFonts：缺嵌入字体时回退系统字体，mac 上提升中文抽取率。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true
  })
  const pdf = await loadingTask.promise

  const blocks: ParsedBlock[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    // 必须 await 完再进下一页：getTextContent 的结果与 page 对象生命周期绑定
    const content = await page.getTextContent()
    const lines: string[] = []
    for (const item of content.items) {
      // items 可能是 TextItem 或 TextMarkedContent，只有前者有 str
      if (!('str' in item)) continue
      lines.push(item.str)
      // hasEOL 标记 PDF 文本流中的换行位置（官方推荐的拼行依据）
      if ('hasEOL' in item && item.hasEOL) lines.push('\n')
    }
    const pageText = lines.join('')
    blocks.push(
      ...groupLinesIntoParagraphs(pageText.split('\n'), () => pageNum)
    )
  }
  // pdfjs 6：销毁入口在 loadingTask（会一并关 worker 与文档代理）
  await loadingTask.destroy()
  return blocks
}

// ---------------- 共享工具 ----------------

/**
 * 行序列 → 段落块：空行断段，连续非空行合并。
 * pageOf 在 flush 时求值（PDF 每个段落的行属于同一页）。
 */
function groupLinesIntoParagraphs(
  lines: string[],
  pageOf: () => number | null
): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length > 0) {
      const text = buffer.join('\n').trim()
      if (text) {
        blocks.push({
          kind: 'paragraph',
          text: sanitize(text),
          page: pageOf()
        })
      }
      buffer = []
    }
  }

  for (const line of lines) {
    if (line.trim() === '') flush()
    else buffer.push(line)
  }
  flush()
  return blocks
}

/** 去掉 NUL 等控制字符（PDF 抽取常见脏字符），保留常规空白与换行 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}
