/**
 * 混合检索纯函数：查询词构造（白名单/三元组/短词）与 RRF 融合。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueryTerms,
  reciprocalRankFusion
} from '../src/main/services/rag/hybrid.ts'

test('中文长查询切成滑动三元组，原子全部双引号包裹', () => {
  const t = buildQueryTerms('向量数据库')!
  // 向向量、量数据、数据库 三个三元组
  assert.equal(t.trigrams.length, 3)
  assert.ok(t.matchExpr.startsWith('"'))
  for (const atom of t.matchExpr.split(' OR ')) {
    assert.match(atom, /^".*"$/)
  }
})

test('2 字中文短词不产生词元（trigram 下限，留给向量路）', () => {
  assert.equal(buildQueryTerms('闷蒸'), null)
  assert.equal(buildQueryTerms('ab'), null)
})

test('英文/数字词保留为整体短语，FTS 语法字符被白名单滤掉', () => {
  const t = buildQueryTerms('bm25"* OR ')!
  assert.ok(t.phrases.includes('bm25'))
  assert.ok(!t.matchExpr.includes('"*'))
  assert.ok(!/OR\(/.test(t.matchExpr))
})

test('RRF：两路都命中的项排在只命中一路的前面', () => {
  const fused = reciprocalRankFusion(
    ['a', 'b'],
    ['b', 'c'],
    60
  )
  assert.equal(fused[0].chunkId, 'b')
  assert.equal(fused[0].inVector, true)
  assert.equal(fused[0].inKeyword, true)
  const names = fused.map((f) => f.chunkId)
  assert.deepEqual(names.sort(), ['a', 'b', 'c'])
})
