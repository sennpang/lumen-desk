import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HierarchicalNSW } from 'hnswlib-node'
import { vectorsDir } from '../../paths'

/**
 * 向量索引存储（PRD 12.1：HNSW 文件索引，向量不入库）
 *
 * 关键约束——hnswlib-node 的 label 只能是整数（C++ size_t），
 * 而我们的 chunk 主键是 uuid 字符串。因此在索引旁维护一个 JSON 映射：
 *   vectors/{kbId}.index       HNSW 二进制索引
 *   vectors/{kbId}.meta.json   { dim, nextLabel, labels: {int: uuid} }
 *
 * 无状态函数式 API：每次操作 load → 操作 → save（检索不 save）。
 * 导入是低频操作，简单可靠优先；检索与写入使用不同实例，互不共享内存
 * 状态，也就没有并发锁问题（写入落盘后，检索下次 load 自然看到新数据）。
 *
 * 持久化用「写 .tmp + rename」：rename 在同一卷上原子，崩溃也不会留下
 * 写坏一半的索引文件。
 */

type Space = 'cosine' | 'l2' | 'ip'

const SPACE: Space = 'cosine' // 文本检索标准选择：只看方向不看模长
const INITIAL_CAPACITY = 1024
const CAPACITY_GROW = 4

interface VectorItem {
  chunkId: string
  vector: number[]
}

export interface SearchHit {
  chunkId: string
  distance: number
}

interface IndexMeta {
  dim: number
  space: Space
  nextLabel: number
  /** 整数 label → chunkId（单调分配，删除后留下空洞但不复用） */
  labels: Record<number, string>
}

function indexPath(kbId: string): string {
  return path.join(vectorsDir(), `${kbId}.index`)
}

function metaPath(kbId: string): string {
  return path.join(vectorsDir(), `${kbId}.meta.json`)
}

async function readMeta(kbId: string): Promise<IndexMeta | null> {
  try {
    const raw = await readFile(metaPath(kbId), 'utf-8')
    return JSON.parse(raw) as IndexMeta
  } catch {
    return null
  }
}

async function writeMetaAtomic(kbId: string, meta: IndexMeta): Promise<void> {
  const target = metaPath(kbId)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(meta))
  await rename(tmp, target)
}

async function saveIndexAtomic(index: HierarchicalNSW, kbId: string): Promise<void> {
  const target = indexPath(kbId)
  const tmp = `${target}.tmp`
  // hnswlib-node 3.x API：writeIndexSync（旧版教程里的 saveIndex 已移除）
  index.writeIndexSync(tmp)
  await rename(tmp, target)
}

/**
 * 追加向量（新文档导入）。索引/meta 不存在时用给定 dim 创建。
 * @returns 本次实际写入的向量数
 */
export async function appendVectors(
  kbId: string,
  items: VectorItem[]
): Promise<number> {
  if (items.length === 0) return 0
  // 不依赖启动初始化顺序：首次写入前确保 vectors 目录存在
  await mkdir(vectorsDir(), { recursive: true })
  const dim = items[0].vector.length
  items.forEach((it, i) => {
    if (it.vector.length !== dim) {
      throw new Error(`第 ${i + 1} 个向量维度 ${it.vector.length} 与首个 ${dim} 不一致。`)
    }
  })

  const existing = await readMeta(kbId)
  const index = new HierarchicalNSW(SPACE, dim)
  let meta: IndexMeta

  if (existing && existsSync(indexPath(kbId))) {
    if (existing.dim !== dim) {
      throw new Error(
        `向量维度与索引不一致（索引 ${existing.dim} 维，当前模型 ${dim} 维）。` +
          '更换 embedding 模型后请对知识库执行「重建索引」。'
      )
    }
    meta = existing
    // 3.x API：维度在构造函数；readIndexSync 不接受容量参数，
    // 加载后按当前容量 + 本次增量判断是否扩容
    index.readIndexSync(indexPath(kbId))
    const need = Object.keys(meta.labels).length + items.length
    if (need > index.getMaxElements()) {
      index.resizeIndex(Math.max(need, index.getMaxElements() * 2))
    }
  } else {
    meta = { dim, space: SPACE, nextLabel: 0, labels: {} }
    // 3.x API：new HierarchicalNSW(space, numDimensions)，initIndex 只给容量
    index.initIndex(Math.max(INITIAL_CAPACITY, items.length) * CAPACITY_GROW)
  }

  // 分配整数 label（单调递增，不复用已删除的 label）
  let nextLabel = meta.nextLabel
  for (const item of items) {
    const label = nextLabel++
    meta.labels[label] = item.chunkId
    index.addPoint(item.vector, label)
  }
  meta.nextLabel = nextLabel
  await saveIndexAtomic(index, kbId)
  await writeMetaAtomic(kbId, meta)
  return items.length
}

/**
 * 近似最近邻检索。
 * @param k 期望返回条数；实际不超过索引现存元素数
 */
export async function searchVectors(
  kbId: string,
  vector: number[],
  k: number
): Promise<SearchHit[]> {
  const meta = await readMeta(kbId)
  if (!meta || !existsSync(indexPath(kbId))) return [] // 空库：无结果
  if (meta.dim !== vector.length) {
    throw new Error(
      `查询向量维度 ${vector.length} 与索引 ${meta.dim} 维不一致，请重建索引。`
    )
  }

  const elementCount = Object.keys(meta.labels).length
  if (elementCount === 0 || k <= 0) return []

  const index = new HierarchicalNSW(SPACE, meta.dim)
  // 只读加载：容量已在索引文件中，无需也无法在读取时指定
  index.readIndexSync(indexPath(kbId))

  const result = index.searchKnn(vector, Math.min(k, elementCount))
  const hits: SearchHit[] = []
  result.neighbors.forEach((label, i) => {
    const chunkId = meta.labels[label]
    // label 可能指向已删除但物理上仍在图中的节点（正常情况下 meta 已先清掉）
    if (chunkId) hits.push({ chunkId, distance: result.distances[i] })
  })
  return hits
}

/**
 * 从索引移除片段（删除文档时）。空索引直接清理文件。
 */
export async function removeVectors(kbId: string, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return
  const meta = await readMeta(kbId)
  if (!meta || !existsSync(indexPath(kbId))) return

  const chunkSet = new Set(chunkIds)
  const labelsToRemove = Object.entries(meta.labels)
    .filter(([, id]) => chunkSet.has(id))
    .map(([label]) => Number(label))
  if (labelsToRemove.length === 0) return

  const index = new HierarchicalNSW(SPACE, meta.dim)
  index.readIndexSync(indexPath(kbId))
  labelsToRemove.forEach((label) => index.markDelete(label))

  for (const label of labelsToRemove) delete meta.labels[label]

  if (Object.keys(meta.labels).length === 0) {
    // 全删光：连文件一起清，下次导入以全新索引开始（避免空洞累积）
    await safeUnlink(indexPath(kbId))
    await safeUnlink(metaPath(kbId))
  } else {
    await saveIndexAtomic(index, kbId)
    await writeMetaAtomic(kbId, meta)
  }
}

/** 删除整个知识库的索引文件（删除知识库时） */
export async function deleteKbIndex(kbId: string): Promise<void> {
  await safeUnlink(indexPath(kbId))
  await safeUnlink(metaPath(kbId))
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
