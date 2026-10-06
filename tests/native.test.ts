/**
 * 原生模块冒烟：better-sqlite3 与 hnswlib-node 是 C++ ABI 绑定，
 * electron-builder install-app-deps 会把它们重编到 Electron ABI。
 * 本套件用 ELECTRON_RUN_AS_NODE 跑，第一时间发现"模块能装上但加载不了"
 * （NODE_MODULE_VERSION 不匹配）这类打包环境问题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import hnswlib from 'hnswlib-node'

const { HierarchicalNSW } = hnswlib

test('better-sqlite3：建表/预编译/事务可用', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)')
  const insert = db.prepare('INSERT INTO t(name) VALUES(?)')
  const tx = db.transaction((names: string[]) => names.forEach((n) => insert.run(n)))
  tx(['alpha', 'beta'])
  const rows = db.prepare('SELECT name FROM t ORDER BY id').all() as { name: string }[]
  assert.deepEqual(rows, [{ name: 'alpha' }, { name: 'beta' }])
  db.close()
})

test('hnswlib-node：建索引/写入向量/近邻检索可用', () => {
  const dim = 4
  const index = new HierarchicalNSW('l2', dim)
  index.initIndex(8, 4, 16, 42)
  // 两条方向明显不同的 4 维向量
  index.addPoint([1, 0, 0, 0], 0)
  index.addPoint([0, 1, 0, 0], 1)
  assert.equal(index.getMaxElements(), 8)
  const result = index.searchKnn([0.9, 0.1, 0, 0], 1)
  assert.equal(result.neighbors[0], 0)
})
