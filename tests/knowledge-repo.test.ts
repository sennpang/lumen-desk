/**
 * 知识库仓储冒烟：trigram FTS 召回、库间隔离、删除无幽灵片段、级联删除。
 * 不依赖 Ollama / 网络 / embedding 服务——只测 SQLite 层。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { makeTempDb, type TempDb } from './helpers/temp-db.ts'
import {
  createKb,
  deleteDoc,
  deleteKb,
  insertChunks,
  insertDoc,
  listDocs,
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

function seedDoc(kbId: string, name: string, contents: string[]) {
  const doc = insertDoc({ kbId, fileName: name, fileHash: null })
  insertChunks(
    doc.id,
    contents.map((content) => ({
      id: randomUUID(),
      content,
      tokenCount: content.length,
      meta: { page: 1, headingPath: name }
    }))
  )
  return doc
}

test('trigram FTS：中文子串可召回且 BM25 更相关者靠前', () => {
  const kb = createKb('笔记')
  seedDoc(kb.id, 'a.txt', ['向量数据库适合做语义相似度检索。'])
  seedDoc(kb.id, 'b.txt', ['今天天气不错，适合出门散步。'])

  const terms = buildQueryTerms('向量数据库怎么做相似度检索')
  assert.ok(terms, '查询应产生可用词元')
  const hits = searchChunksByKeyword(kb.id, terms.matchExpr, 5)
  assert.ok(hits.length >= 1)
  assert.match(hits[0].chunk.content, /向量数据库/)
  assert.equal(hits[0].chunk.docName, 'a.txt')
})

test('FTS 库间隔离：只在指定知识库内召回', () => {
  const kb1 = createKb('库一')
  const kb2 = createKb('库二')
  seedDoc(kb1.id, 'x.txt', ['两个库里放同样的向量数据库内容。'])
  seedDoc(kb2.id, 'y.txt', ['两个库里放同样的向量数据库内容。'])

  const terms = buildQueryTerms('向量数据库')!
  const hits2 = searchChunksByKeyword(kb2.id, terms.matchExpr, 10)
  assert.equal(hits2.length, 1)
  assert.equal(hits2[0].chunk.docName, 'y.txt')
})

test('删文档后 FTS 不残留幽灵片段', () => {
  const kb = createKb('库')
  const doc = seedDoc(kb.id, 'ghost.txt', ['待删除文档里的向量数据库片段。'])
  const terms = buildQueryTerms('向量数据库')!
  assert.equal(searchChunksByKeyword(kb.id, terms.matchExpr, 10).length, 1)

  deleteDoc(doc.id)
  assert.equal(listDocs(kb.id).length, 0)
  assert.equal(searchChunksByKeyword(kb.id, terms.matchExpr, 10).length, 0)
})

test('删知识库级联清掉 document/chunk/FTS（foreign_keys=ON 验证）', () => {
  const kb = createKb('库')
  seedDoc(kb.id, 'c.txt', ['向量数据库内容 A。', '向量数据库内容 B。'])

  deleteKb(kb.id)
  const db = getDb()
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM document').get() as { n: number }).n,
    0
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM chunk').get() as { n: number }).n,
    0
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM chunk_fts').get() as { n: number }).n,
    0
  )
})

test('恶意 FTS 语法字符经白名单构造后不会让 MATCH 报错', () => {
  const kb = createKb('库')
  seedDoc(kb.id, 's.txt', ['正常的向量数据库内容。'])
  // 引号/星号/括号若未过滤会直接造成 MATCH 语法错误
  const terms = buildQueryTerms('向量数据库"* OR (("')!
  assert.doesNotThrow(() => searchChunksByKeyword(kb.id, terms.matchExpr, 10))
})
