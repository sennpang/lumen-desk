import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * 统一的数据目录管理（PRD 12.1 存储布局）
 *
 * {userData}/
 * ├─ lumen.db            # SQLite 结构化数据（会话/文档元数据）
 * ├─ secrets.enc         # safeStorage 加密的 API Key
 * ├─ vectors/            # HNSW 向量索引文件（{kbId}.index）
 * └─ cache/embeddings/   # embedding 缓存（按文本 hash，省钱）
 *
 * 为什么集中在 paths.ts：
 * 所有模块从同一个地方取路径，避免散落各处的 join(app.getPath('userData'), ...)
 * 导致目录名不一致；后续做"数据目录迁移/备份"也只改这一个文件。
 */

/** 应用数据根目录（macOS: ~/Library/Application Support/lumen-desk） */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function dbPath(): string {
  return join(userDataDir(), 'lumen.db')
}

export function secretsPath(): string {
  return join(userDataDir(), 'secrets.enc')
}

export function vectorsDir(): string {
  return join(userDataDir(), 'vectors')
}

export function embeddingCacheDir(): string {
  return join(userDataDir(), 'cache', 'embeddings')
}

/** 启动时确保目录存在（mkdir recursive 幂等，已存在不报错） */
export function ensureDataDirs(): void {
  mkdirSync(vectorsDir(), { recursive: true })
  mkdirSync(embeddingCacheDir(), { recursive: true })
}
