import BetterSqlite3 from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { dbPath } from '../paths'
import schemaSql from './schema.sql?raw'

/**
 * SQLite 连接与初始化（PRD 第 12 章）
 *
 * 单文件库位于 {userData}/lumen.db。整个应用共享一个连接实例：
 * better-sqlite3 的 Database 本身就是线程安全的串行执行器，
 * 且主进程只有一个，无需连接池。
 */

let db: DatabaseType | null = null

export function getDb(): DatabaseType {
  if (!db) throw new Error('数据库尚未初始化：请先调用 initDb()')
  return db
}

export function initDb(): DatabaseType {
  if (db) return db

  const conn = new BetterSqlite3(dbPath())
  db = conn

  // -------- PRAGMA：每个 SQLite 工程都该懂的四件套 --------
  conn.pragma('journal_mode = WAL') // WAL：读写不互相阻塞，崩溃更稳（多生成 -wal/-shm 旁车文件）
  conn.pragma('foreign_keys = ON') // SQLite 默认不强制外键！不开启则 ON DELETE CASCADE 不生效
  conn.pragma('synchronous = NORMAL') // WAL 下 NORMAL 足够安全且更快，FULL 每次写都 fsync 太慢
  conn.pragma('busy_timeout = 5000') // 偶发锁竞争时等待 5s 而不是立刻抛 SQLITE_BUSY

  // 建表（IF NOT EXISTS，幂等，每次启动执行安全）
  conn.exec(schemaSql)

  // 增量迁移（schema.sql 的 CREATE 只影响新库；已存在的表不会被改动）
  runMigrations(conn)

  return conn
}

/**
 * 轻量迁移机制：SQLite 的 ALTER TABLE 不支持 ADD COLUMN IF NOT EXISTS，
 * 所以先查 pragma table_info，缺列才补。每个迁移写成幂等语句，
 * 老用户升级应用、新用户全新建库，走的都是同一条路径。
 */
function runMigrations(conn: DatabaseType): void {
  const addColumnIfMissing = (
    table: string,
    column: string,
    ddl: string
  ): void => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string
    }[]
    if (!cols.some((c) => c.name === column)) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
  }

  // M3：document 记录解析失败原因（F-C1）
  addColumnIfMissing('document', 'error', 'error TEXT')
}

export function closeDb(): void {
  db?.close()
  db = null
}
