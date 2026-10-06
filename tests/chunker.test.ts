/**
 * 切分器冒烟（纯逻辑、无 I/O）：
 * - 标题边界强制切块，块 meta 带标题面包屑
 * - 超长段落滑窗 + 窗口间真实重叠
 * - 微小尾块合并
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkDocument } from '../src/main/services/rag/chunker.ts'
import type { ParsedBlock, ParsedDoc } from '../src/main/services/rag/types.ts'

function doc(blocks: ParsedBlock[]): ParsedDoc {
  return { format: 'txt', blocks }
}

test('不同标题小节不会混进同一个块，meta 保留面包屑', () => {
  const para = '这是一个足够普通的段落，没有任何超长内容，只用于占一点预算。'
  const chunks = chunkDocument(
    doc([
      { kind: 'heading', level: 1, text: '第一章' },
      { kind: 'paragraph', text: para, page: 1 },
      { kind: 'heading', level: 1, text: '第二章' },
      { kind: 'paragraph', text: para, page: 2 }
    ])
  )
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].meta.headingPath, '第一章')
  assert.equal(chunks[0].meta.page, 1)
  assert.equal(chunks[1].meta.headingPath, '第二章')
  assert.equal(chunks[1].meta.page, 2)
})

test('单段落超长时滑窗切分，相邻窗口有重叠内容', () => {
  const longText = '向量数据库。'.repeat(200) // ~1000 字，远超默认 500 token 预算
  const chunks = chunkDocument(
    doc([{ kind: 'paragraph', text: longText, page: null }]),
    { targetTokens: 100, overlapTokens: 20 }
  )
  assert.ok(chunks.length >= 2, `应该切成多块，实际 ${chunks.length}`)
  // 第二块开头应能在第一块尾部找到（句读回退导致的重叠）
  const head = chunks[1].content.slice(0, 6)
  assert.ok(chunks[0].content.includes(head), '相邻窗口缺少重叠')
})

test('结尾小碎片并入上一块（同小节）', () => {
  // 99 字的单段 + 3 字短尾：合入将超过 100 预算而封口，
  // 尾巴仅 3 token（<100 的 15%）应被 mergeTinyTail 合并回上一块
  const big = '甲'.repeat(99)
  const chunks = chunkDocument(
    doc([
      { kind: 'paragraph', text: big, page: 1 },
      { kind: 'paragraph', text: '短尾巴', page: 1 }
    ]),
    { targetTokens: 100 }
  )
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].content.endsWith('短尾巴'))
})

test('空文档产出空数组而不是抛错', () => {
  assert.deepEqual(chunkDocument(doc([])), [])
})
