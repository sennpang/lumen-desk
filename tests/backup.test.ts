/**
 * 全量备份/恢复冒烟（t6）：
 * - 导出包含会话消息原始 meta（citations）与 agent_step
 * - 恢复进新库后计数一致、citation meta 可解析、FTS 可检索
 * - 同 id 重复导入整组跳过（幂等）
 * - 脏数据：错误 kind 抛错，畸形条目被 sanitize 丢弃
 * - 恢复结果只对"含片段的库"提示重建向量索引
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { makeTempDb, type TempDb } from './helpers/temp-db.ts'
import { buildDataBackup, restoreDataBackup } from '../src/main/services/backup.ts'
import {
  exportConversationsForBackup,
  addMessage,
  createConversation,
  listMessages
} from '../src/main/services/conversations/repo.ts'
import { insertStep } from '../src/main/services/agent/repo.ts'
import {
  createKb,
  insertChunks,
  insertDoc,
  searchChunksByKeyword
} from '../src/main/services/knowledge/repo.ts'
import { buildQueryTerms } from '../src/main/services/rag/hybrid.ts'
import { getDb } from '../src/main/db/sqlite.ts'

let temp: TempDb

beforeEach(() => {
  temp = makeTempDb()
})
afterEach(() => {
  temp.dispose()
})

function seed() {
  const conv = createConversation('agent', 'model-x')
  addMessage({ conversationId: conv.id, role: 'user', content: '备份里的用户问题' })
  const assistant = addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: '带引用的回答',
    citations: [{ chunkId: 'c1', docName: 'd.txt', content: '片段原文' }]
  })
  insertStep({
    messageId: assistant.id,
    seq: 0,
    stepType: 'thought',
    args: { thought: '想一想' }
  })

  const kb = createKb('迁移库')
  const doc = insertDoc({ kbId: kb.id, fileName: 'd.txt', fileHash: 'h1' })
  insertChunks(doc.id, [
    { id: 'c1', content: '向量数据库迁移片段一', tokenCount: 10, meta: { page: 1 } },
    { id: 'c2', content: '另一段完全不同的内容', tokenCount: 9, meta: { page: 2 } }
  ])

  // 空知识库：不应出现在 reindexKbIds
  createKb('空库')
  return { convId: conv.id, kbId: kb.id }
}

test('导出 → 新库恢复：计数一致，citation/步骤/FTS 都在', () => {
  const { convId, kbId } = seed()
  const backup = buildDataBackup('0.0.0-test')
  assert.equal(backup.kind, 'lumen-desk-data')
  assert.equal(backup.conversations.length, 1)
  assert.equal(backup.knowledgeBases.length, 2)

  // 恢复进同一个库：全部 id 冲突跳过
  const same = restoreDataBackup(backup)
  assert.deepEqual(same.conversations, { imported: 0, skipped: 1 })
  assert.equal(same.knowledgeBases.skipped, 2)
  assert.deepEqual(same.reindexKbIds, [])

  // 换一个全新的库再恢复
  temp.dispose()
  temp = makeTempDb()
  const result = restoreDataBackup(backup)
  assert.deepEqual(result.conversations, { imported: 1, skipped: 0 })
  assert.equal(result.knowledgeBases.imported, 2)
  assert.equal(result.knowledgeBases.documents, 1)
  assert.equal(result.knowledgeBases.chunks, 2)
  assert.deepEqual(result.reindexKbIds, [kbId])

  // 消息原始 meta 完整：citations 能被正常解析
  const msgs = listMessages(convId)
  assert.equal(msgs.length, 2)
  assert.deepEqual(msgs[1].citations?.[0].chunkId, 'c1')

  // agent_step 跟随消息恢复
  const steps = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_step')
    .get() as { n: number }
  assert.equal(steps.n, 1)

  // FTS 随备份恢复，关键词检索立即可用（不需要等向量重建）
  const terms = buildQueryTerms('向量数据库')!
  const hits = searchChunksByKeyword(kbId, terms.matchExpr, 5)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].chunk.id, 'c1')

  // 再恢复一次：幂等，全部 skip，不产生重复片段
  const again = restoreDataBackup(backup)
  assert.equal(again.conversations.skipped, 1)
  assert.equal(again.knowledgeBases.skipped, 2)
  const terms2 = buildQueryTerms('向量数据库')!
  assert.equal(searchChunksByKeyword(kbId, terms2.matchExpr, 5).length, 1)
})

test('脏备份：错误 kind 拒绝，畸形条目被丢弃不炸库', () => {
  assert.throws(() => restoreDataBackup({ kind: 'lumen-desk-settings' }), /kind/)
  assert.throws(() => restoreDataBackup(null), /kind/)

  const r = restoreDataBackup({
    kind: 'lumen-desk-data',
    conversations: [
      null,
      'oops',
      { id: '', title: '无 id' },
      {
        id: randomUUID(),
        title: 999,
        mode: 'weird-mode',
        createdAt: 'bad',
        messages: [{ id: 'm1', role: 'ghost', content: 42, badField: 1 }]
      }
    ],
    knowledgeBases: [{ name: '没 id' }, { id: randomUUID(), name: '库', documents: 'x' }]
  })
  assert.equal(r.conversations.imported, 1)
  assert.equal(r.knowledgeBases.imported, 1)

  // 被清洗的枚举回落到安全默认值
  const exported = exportConversationsForBackup()
  assert.equal(exported[0].mode, 'chat')
  assert.equal(exported[0].messages[0].role, 'assistant')
  assert.equal(exported[0].messages[0].content, '')
  assert.equal(exported[0].messages[0].status, 'done')
})
