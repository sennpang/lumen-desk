/**
 * 测试夹具：每个用例一个独立临时目录的真实 SQLite 文件库
 * （不用 :memory:——WAL/外键/迁移行为与生产完全一致）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { __bootstrapDbForTests, closeDb } from '../../src/main/db/sqlite.ts'

export interface TempDb {
  dir: string
  dispose: () => void
}

export function makeTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-test-'))
  const conn = new Database(join(dir, 'test.db'))
  __bootstrapDbForTests(conn)
  return {
    dir,
    dispose: () => {
      closeDb()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
