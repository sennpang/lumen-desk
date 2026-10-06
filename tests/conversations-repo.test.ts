/**
 * 会话仓储冒烟：消息序号、历史搜索的 LIKE 通配符转义、
 * 重新生成所依赖的 getLastUserMessage / deleteTrailingAssistant、
 * buildChatHistory 的状态过滤。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeTempDb, type TempDb } from './helpers/temp-db.ts'
import {
  addMessage,
  buildChatHistory,
  createConversation,
  deleteTrailingAssistant,
  getLastUserMessage,
  listMessages,
  searchMessages
} from '../src/main/services/conversations/repo.ts'
import { insertStep } from '../src/main/services/agent/repo.ts'
import { getDb } from '../src/main/db/sqlite.ts'

let temp: TempDb

beforeEach(() => {
  temp = makeTempDb()
})
afterEach(() => {
  temp.dispose()
})

test('消息 seq 在同一事务内自增，不撞 UNIQUE(conversation_id, seq)', () => {
  const conv = createConversation('chat', null)
  addMessage({ conversationId: conv.id, role: 'user', content: '第一条' })
  addMessage({ conversationId: conv.id, role: 'assistant', content: '第二条' })
  const msgs = listMessages(conv.id)
  assert.deepEqual(msgs.map((m) => m.seq), [1, 2])
})

test('搜索历史消息：% _ \\ 被转义为字面量，不当通配符', () => {
  const conv = createConversation('chat', null)
  addMessage({
    conversationId: conv.id,
    role: 'user',
    content: '进度显示 100% 完成，标记位 _done_，路径 C:\\temp'
  })
  addMessage({ conversationId: conv.id, role: 'assistant', content: '完全无关的另一句话' })

  // 若 % 没转义，'100%' 会匹配任意包含 100+任意字符的行（这里语义等价，
  // 真正的回归信号是 '_'：未转义时 '_' 匹配任意单字符 → 命中所有消息）
  const underscoreHits = searchMessages('_')
  assert.ok(underscoreHits.length >= 1)
  assert.ok(underscoreHits.every((h) => h.snippet.includes('_')))

  const exactHits = searchMessages('100%')
  assert.equal(exactHits.length, 1)
  assert.match(exactHits[0].snippet, /100%/)

  const slashHits = searchMessages('C:\\temp')
  assert.equal(slashHits.length, 1)

  // 空查询直接短路
  assert.deepEqual(searchMessages('   '), [])
})

test('重新生成：取最后一条 user，删末尾 assistant 且级联清 agent_step', () => {
  const conv = createConversation('agent', null)
  addMessage({ conversationId: conv.id, role: 'user', content: '问题 A' })
  addMessage({ conversationId: conv.id, role: 'assistant', content: '回答 A' })
  addMessage({ conversationId: conv.id, role: 'user', content: '问题 B' })
  const last = addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: '待作废的回答 B'
  })
  insertStep({ messageId: last.id, seq: 0, stepType: 'thought', args: { x: 1 } })

  assert.equal(getLastUserMessage(conv.id)?.content, '问题 B')

  const deleted = deleteTrailingAssistant(conv.id)!
  assert.equal(deleted.id, last.id)
  assert.equal(deleteTrailingAssistant(conv.id), null, '末尾已是 user，不该再删')

  const msgs = listMessages(conv.id)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])

  const { n: stepCount } = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_step WHERE message_id = ?')
    .get(last.id) as { n: number }
  assert.equal(stepCount, 0, 'assistant 消息删除后其 agent_step 应被级联清除')
})

test('buildChatHistory 只要 done 的消息，streaming 残留不进上下文', () => {
  const conv = createConversation('chat', null)
  addMessage({ conversationId: conv.id, role: 'user', content: '正常问题' })
  addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: '半截回答',
    status: 'streaming'
  })
  addMessage({ conversationId: conv.id, role: 'system', content: '系统提示' })

  const history = buildChatHistory(conv.id)
  assert.deepEqual(
    history.map((m) => m.content),
    ['正常问题', '系统提示']
  )
})
