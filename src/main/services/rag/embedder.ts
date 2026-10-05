import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { embeddingCacheDir } from '../../paths'
import { resolveEmbeddingConfig } from '../llm/resolve'
import type { AppSettings } from '../../../shared/types'

/**
 * Embedding 客户端（PRD 10：Ollama 本地 或 OpenAI 兼容云端 /v1/embeddings）
 *
 * 省钱设计——文件级向量缓存（PRD 12.1）：
 * key = sha256(模型名 + 文本)。同一段文本（含 50 token 重叠窗口在相邻
 * 文档间重复出现）只请求一次；换模型后 key 自动改变，无需手动失效。
 *
 * 另外 embedMany 先按 hash 去重：一个文档内重叠窗口、跨文档重复段落，
 * 一个批次只算一次向量。
 */

interface EmbeddingDeps {
  settings: AppSettings
  cloudApiKey: string | null
}

export type { EmbeddingDeps }

interface CachedVector {
  m: string
  d: number
  v: number[]
}

/** 单条文本向量化（走缓存） */
export async function embedOne(
  text: string,
  deps: EmbeddingDeps
): Promise<number[]> {
  const [vec] = await embedMany([text], deps)
  return vec
}

/** 批量向量化：去重 → 查缓存 → 只请求缺失项 */
export async function embedMany(
  texts: string[],
  deps: EmbeddingDeps
): Promise<number[][]> {
  if (texts.length === 0) return []

  const resolved = resolveEmbeddingConfig(deps.settings, deps.cloudApiKey)
  if (!resolved.ok) throw new Error(resolved.message)
  const { baseUrl, apiKey, model } = resolved.config

  const cacheDir = embeddingCacheDir()
  await mkdir(cacheDir, { recursive: true })

  // 去重：hash -> 首次出现位置；结果再按位置回填
  const hashOf = (t: string) =>
    createHash('sha256').update(`${model}\u0000${t}`).digest('hex')
  const hashes = texts.map(hashOf)
  const uniqueHashes = [...new Set(hashes)]

  const vectorsByHash = new Map<string, number[]>()

  // 1) 读缓存
  const missing: string[] = []
  const hashToText = new Map<string, string>()
  hashes.forEach((h, i) => hashToText.set(h, texts[i]))

  await Promise.all(
    uniqueHashes.map(async (h) => {
      const cached = await readCache(cacheDir, h)
      if (cached) vectorsByHash.set(h, cached)
      else missing.push(h)
    })
  )

  // 2) 串行请求缺失项（本地模型串行更稳；每条独立超时，模型冷启动给 60s）
  for (const h of missing) {
    const text = hashToText.get(h)!
    const vec = await requestEmbedding(baseUrl, apiKey, model, text)
    vectorsByHash.set(h, vec)
    await writeCache(cacheDir, h, { m: model, d: vec.length, v: vec })
  }

  // 3) 按原顺序回填（重复 hash 共享同一向量对象引用也无所谓）
  return hashes.map((h) => vectorsByHash.get(h)!)
}

// ---------------- HTTP ----------------

function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1')
    ? `${trimmed}/embeddings`
    : `${trimmed}/v1/embeddings`
}

async function requestEmbedding(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string
): Promise<number[]> {
  let res: Response
  try {
    res = await fetch(embeddingsEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(60_000)
    })
  } catch (err) {
    throw new Error(
      `无法连接 embedding 服务（${baseUrl}）。` +
        `本地模式请确认 Ollama 已启动；详情：${(err as Error).message}`
    )
  }

  const raw = await res.text()
  if (!res.ok) {
    // Ollama 模型未拉取时返回 404 + "model not found"
    if (res.status === 404) {
      throw new Error(
        `embedding 模型「${model}」不存在。本地模式请先运行：ollama pull ${model}`
      )
    }
    throw new Error(`embedding 接口返回 ${res.status}：${raw.slice(0, 300)}`)
  }

  let data: { data?: Array<{ embedding?: number[] }> }
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('embedding 接口返回了无法解析的内容。')
  }
  const vec = data.data?.[0]?.embedding
  if (!vec || !Array.isArray(vec) || vec.length === 0) {
    throw new Error('embedding 接口返回结构异常：缺少 data[0].embedding。')
  }
  return vec
}

// ---------------- 缓存读写 ----------------

function cachePath(cacheDir: string, hash: string): string {
  return path.join(cacheDir, `${hash}.json`)
}

async function readCache(
  cacheDir: string,
  hash: string
): Promise<number[] | null> {
  try {
    const raw = await readFile(cachePath(cacheDir, hash), 'utf-8')
    const parsed = JSON.parse(raw) as CachedVector
    if (Array.isArray(parsed.v) && parsed.v.length > 0) return parsed.v
    return null
  } catch {
    return null // 文件不存在或损坏：视为未命中
  }
}

async function writeCache(
  cacheDir: string,
  hash: string,
  payload: CachedVector
): Promise<void> {
  // 单个文件写失败不应让导入失败（缓存只是优化，不是数据源）
  try {
    await writeFile(cachePath(cacheDir, hash), JSON.stringify(payload))
  } catch {
    // 静默忽略（磁盘满/权限问题在真实写入环节会再次暴露）
  }
}
