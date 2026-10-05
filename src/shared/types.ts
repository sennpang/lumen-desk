/**
 * 领域模型与跨进程共享类型（PRD 第 12 章数据模型 / 第 13 章接口）
 *
 * 这个文件同时被主进程和渲染进程引用：
 * - 主进程用它约束落库/出参
 * - 渲染进程通过 preload 的 window.api 拿到的就是这些类型
 * 纯类型文件，编译后不产生任何运行时代码，不破坏双进程隔离。
 */

/** 会话模式（PRD：conversation.mode） */
export type ChatMode = 'chat' | 'rag' | 'agent'

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export type MessageStatus = 'streaming' | 'done' | 'error'

/** 会话列表项 */
export interface ConversationInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  mode: ChatMode
  modelId: string | null
}

/** RAG 引用（一条被注入并展示的来源片段；持久化在 assistant 消息上） */
export interface CitationRef {
  chunkId: string
  docName: string
  snippet: string
  page: number | null
}

/** 消息记录（message 表一行） */
export interface MessageRecord {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  status: MessageStatus
  tokens: number | null
  createdAt: number
  seq: number
  /** RAG 回答携带的引用来源（mode=rag 的 assistant 消息） */
  citations?: CitationRef[]
}

/** 发给 LLM 的对话消息（多轮上下文的基本单位） */
export interface ChatMessage {
  role: MessageRole
  content: string
  /** tool 角色消息携带的工具名（M5 使用，M1 占位） */
  name?: string
}

/** 模型来源 */
export type ModelProvider = 'cloud' | 'local'

/** embedding 向量化来源（可独立于对话模型选择） */
export type EmbeddingProvider = 'ollama' | 'cloud'

/** 非密设置（app_setting 表） */
export interface AppSettings {
  provider: ModelProvider
  /** 云端 OpenAI 兼容网关地址，默认 DeepSeek */
  baseUrl: string
  model: string
  /** 本地 Ollama 服务地址（F-B2，默认 11434 端口） */
  ollamaUrl: string
  /** 已选择的本地模型（带 tag，如 qwen2.5:7b）；空串表示尚未选择 */
  ollamaModel: string
  /** 向量化服务来源：默认本地（local-first，导入文档也可完全离线） */
  embeddingProvider: EmbeddingProvider
  /** Ollama embedding 模型（如 nomic-embed-text / bge-m3） */
  ollamaEmbedModel: string
  /** 云端 embedding 模型（OpenAI 兼容 /embeddings，复用云端 baseUrl 与 Key） */
  cloudEmbedModel: string
  /** 生成参数（F-B3） */
  temperature: number
  systemPrompt: string
  /** 上下文窗口上限（tokens 估算值），超出触发压缩 */
  maxContextTokens: number
}

/** Ollama 服务探测结果（ollama:status 的返回契约，永不抛错） */
export interface OllamaStatus {
  available: boolean
  version: string | null
  /** 不可用原因（如 connect ECONNREFUSED / 超时），供 UI 给引导文案 */
  reason: string | null
}

/** Ollama 已安装模型（来自 GET /api/tags） */
export interface OllamaModelInfo {
  /** 带 tag 的完整名，如 qwen2.5:7b，调用时直接使用 */
  name: string
  /** 参数量，如 7B */
  parameterSize: string
  /** 量化级别，如 Q4_0 */
  quantization: string
  /** 模型大小（字节） */
  size: number
}

/** 渲染端能看到的设置视图：API Key 永不下发明文，只告知是否已配置 */
export interface SettingsView extends AppSettings {
  hasApiKey: boolean
}

/** 保存设置入参：apiKey 为可选——留空表示沿用已存密钥，填了才覆盖 */
export interface SaveSettingsInput extends AppSettings {
  apiKey?: string
}

// ---------------- 知识库（M3 / PRD 第 12 章） ----------------

export type DocStatus = 'parsing' | 'ready' | 'failed'

export interface KnowledgeBaseInfo {
  id: string
  name: string
  createdAt: number
  /** 库内文档数（聚合字段） */
  docCount: number
}

export interface DocumentInfo {
  id: string
  kbId: string
  fileName: string
  fileHash: string | null
  status: DocStatus
  chunkCount: number
  createdAt: number
  /** 解析失败原因（status=failed 时存在） */
  error: string | null
}

/** chunk 元信息：PDF 有页码；Markdown 有标题面包屑 */
export interface ChunkMeta {
  page?: number | null
  headingPath?: string
}

export interface ChunkInfo {
  id: string
  documentId: string
  chunkIndex: number
  content: string
  tokenCount: number | null
  meta: ChunkMeta
  /** 查询场景下联表带出的所属文档名 */
  docName?: string
}

/** 检索命中片段（retriever 输出，拼 prompt 与 citation 事件共用） */
export interface RetrievedChunk extends ChunkInfo {
  /** 相似度距离（cosine，越小越相似；仅调试/排序展示用） */
  distance: number
}
