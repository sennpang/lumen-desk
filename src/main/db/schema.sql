-- Lumen Desk 数据模型（PRD 第 12 章）
-- 设计约定：
-- 1. 主键统一用 TEXT（应用层生成 uuid），避免 INTEGER 自增在数据迁移/同步时的耦合
-- 2. 时间戳统一 INTEGER 存 Unix 毫秒（Date.now()）
-- 3. JSON 字段用 TEXT 存，应用层负责序列化/反序列化
-- 4. 外键显式声明 ON DELETE CASCADE（需在连接层 PRAGMA foreign_keys=ON 才生效）

CREATE TABLE IF NOT EXISTS conversation (
  id          TEXT PRIMARY KEY,          -- uuid
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'chat', -- chat | rag | agent
  model_id    TEXT,                        -- 记录当时使用的模型
  meta        TEXT                         -- JSON 预留
);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,          -- user | assistant | tool | system
  content         TEXT NOT NULL,          -- 文本(tool 存结果摘要)
  status          TEXT NOT NULL DEFAULT 'done', -- streaming | done | error
  tokens          INTEGER,
  created_at      INTEGER NOT NULL,
  seq             INTEGER NOT NULL,       -- 会话内顺序
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON message(conversation_id, seq);

-- Agent 步骤（M5 时间线与重放使用，M1 先建表）
CREATE TABLE IF NOT EXISTS agent_step (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  step_type   TEXT NOT NULL,              -- thought | tool_call | observation
  tool_name   TEXT,
  args        TEXT,                       -- JSON
  result      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_hash   TEXT,                       -- 去重/变更检测
  status      TEXT NOT NULL,              -- parsing | ready | failed
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,              -- 原文片段（引用跳转用）
  token_count INTEGER,
  meta        TEXT,                       -- 页码等 JSON
  UNIQUE (document_id, chunk_index)
);
-- 注意：chunk 的向量不入库，写入 vectors/{kbId}.index，以 chunk.id 为 label 关联

CREATE TABLE IF NOT EXISTS app_setting (
  key    TEXT PRIMARY KEY,                -- 非密配置；密钥走 safeStorage
  value  TEXT NOT NULL
);
