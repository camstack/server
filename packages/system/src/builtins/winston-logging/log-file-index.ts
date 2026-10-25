/**
 * The sidecar index of one daily log file (D898).
 *
 * The file is cut into BLOCKS of about {@link BLOCK_BYTES}, always on a line
 * boundary, and each block records what a reader needs to decide, without
 * reading it, that it cannot hold a match: its byte range, its time range,
 * the devices / addons / nodes that appear in it, and its highest level.
 *
 * Every recorded set is a SUPERSET of the truth — the facts are pulled off the
 * raw line by pattern, so a `deviceId` inside `meta` counts too. A superset
 * can only cost a block read that finds nothing; it can never hide a line.
 * When a set would grow past {@link MAX_SET}, the block records `null`
 * ("anything") instead.
 *
 * Stored next to the file as `<file>.idx`, JSON lines: a header, then one
 * line per COMPLETED block. The open block is never written; on restart the
 * indexer resumes at the last completed block's end. An index whose header
 * does not match the file (another inode, a newer format) or whose blocks do
 * not tile the file from byte 0 is discarded and rebuilt — it is a cache.
 */
import * as fs from 'node:fs/promises'
import { z } from 'zod'

export const INDEX_VERSION = 1
export const BLOCK_BYTES: number = 1024 * 1024
/** Above this many distinct values a block's set becomes `null` (anything). */
export const MAX_SET = 256
/** Chunk size for reading the file while indexing. */
const READ_CHUNK = 4 * 1024 * 1024

const LEVEL_RANK: Readonly<Record<string, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

const IndexHeaderSchema = z.object({
  v: z.literal(INDEX_VERSION),
  ino: z.number(),
  block: z.number().int().positive(),
})

/** One completed block of the sidecar. */
export interface IndexBlock {
  /** Byte range [s, e), e on a line boundary. */
  readonly s: number
  readonly e: number
  readonly n: number
  /** Epoch ms range; null when a line's timestamp could not be read. */
  readonly t0: number | null
  readonly t1: number | null
  readonly d: number[] | null
  readonly a: string[] | null
  readonly o: string[] | null
  /** Highest level rank in the block. */
  readonly l: number
}

const IndexBlockSchema: z.ZodType<IndexBlock> = z.object({
  /** Byte range [s, e), e on a line boundary. */
  s: z.number().int().nonnegative(),
  e: z.number().int().positive(),
  n: z.number().int().nonnegative(),
  /** Epoch ms range; null when a line's timestamp could not be read. */
  t0: z.number().nullable(),
  t1: z.number().nullable(),
  d: z.array(z.number()).nullable(),
  a: z.array(z.string()).nullable(),
  o: z.array(z.string()).nullable(),
  /** Highest level rank in the block. */
  l: z.number().int().min(0).max(3),
})

/** What one raw line contributes to its block. */
export interface LineFacts {
  readonly ts: number | null
  readonly level: number
  readonly deviceIds: readonly number[]
  readonly addonIds: readonly string[]
  readonly nodes: readonly string[]
}

const RE_LEVEL = /"level":"(debug|info|warn|error)"/
// `format.json()` sorts keys, so the top-level timestamp is the LAST key of
// the line; a `meta.timestamp` sits earlier and never matches the anchor.
const RE_TS = /"timestamp":"([^"\\]{10,40})"\}$/
const RE_DEVICE = /"deviceId":(\d{1,15})(?=[,}])/g
const RE_ADDON = /"addonId":"([^"\\]{1,200})"/g
const RE_AGENT = /"agentId":"([^"\\]{1,200})"/g
const RE_NODE = /"nodeId":"([^"\\/]{1,200})/g

function bare(addonId: string): string {
  let out = addonId.split('@')[0] ?? addonId
  const colon = out.indexOf('::')
  if (colon >= 0) out = out.slice(0, colon)
  return out
}

/** Facts off the raw text — no JSON.parse. */
export function extractLineFacts(line: string): LineFacts {
  const level = RE_LEVEL.exec(line)
  const ts = RE_TS.exec(line)
  const parsedTs = ts?.[1] !== undefined ? Date.parse(ts[1]) : Number.NaN
  const deviceIds: number[] = []
  for (const m of line.matchAll(RE_DEVICE)) deviceIds.push(Number(m[1]))
  const addonIds: string[] = []
  for (const m of line.matchAll(RE_ADDON)) if (m[1] !== undefined) addonIds.push(bare(m[1]))
  const nodes: string[] = []
  for (const m of line.matchAll(RE_AGENT)) if (m[1] !== undefined) nodes.push(m[1])
  for (const m of line.matchAll(RE_NODE)) if (m[1] !== undefined) nodes.push(m[1])
  return {
    ts: Number.isFinite(parsedTs) ? parsedTs : null,
    // An unreadable level counts as the highest: a superset never hides a line.
    level: level?.[1] !== undefined ? (LEVEL_RANK[level[1]] ?? 3) : 3,
    deviceIds,
    addonIds,
    nodes,
  }
}

class GrowingSet<T> {
  private values: Set<T> | null = new Set<T>()
  add(value: T): void {
    if (this.values === null) return
    this.values.add(value)
    if (this.values.size > MAX_SET) this.values = null
  }
  poison(): void {
    this.values = null
  }
  toArray(): T[] | null {
    return this.values === null ? null : [...this.values]
  }
}

/** Accumulates lines into one block. */
export class BlockBuilder {
  private n = 0
  private t0: number | null = Number.POSITIVE_INFINITY
  private t1: number | null = Number.NEGATIVE_INFINITY
  private tsUnknown = false
  private readonly d = new GrowingSet<number>()
  private readonly a = new GrowingSet<string>()
  private readonly o = new GrowingSet<string>()
  private l = 0

  constructor(readonly start: number) {}

  add(facts: LineFacts): void {
    this.n += 1
    if (facts.ts === null) this.tsUnknown = true
    else {
      if (this.t0 !== null && facts.ts < this.t0) this.t0 = facts.ts
      if (this.t1 !== null && facts.ts > this.t1) this.t1 = facts.ts
    }
    for (const id of facts.deviceIds) this.d.add(id)
    for (const id of facts.addonIds) this.a.add(id)
    for (const id of facts.nodes) this.o.add(id)
    if (facts.level > this.l) this.l = facts.level
  }

  /** A line whose facts could not be read: the block may hold anything. */
  addUnknown(): void {
    this.n += 1
    this.tsUnknown = true
    this.d.poison()
    this.a.poison()
    this.o.poison()
    this.l = 3
  }

  get lines(): number {
    return this.n
  }

  finish(end: number): IndexBlock {
    const known = !this.tsUnknown && this.n > 0
    return {
      s: this.start,
      e: end,
      n: this.n,
      t0: known ? this.t0 : null,
      t1: known ? this.t1 : null,
      d: this.d.toArray(),
      a: this.a.toArray(),
      o: this.o.toArray(),
      l: this.l,
    }
  }
}

/** In-memory index state of one file. */
export interface FileIndex {
  readonly ino: number
  /** Completed blocks, ascending, tiling [0, indexedEnd). */
  readonly blocks: IndexBlock[]
}

export function indexEnd(index: FileIndex): number {
  return index.blocks.at(-1)?.e ?? 0
}

export function indexPathOf(logPath: string): string {
  return `${logPath}.idx`
}

/**
 * Load `<file>.idx`. Returns an empty index (to be rebuilt) when the sidecar
 * is missing, belongs to another inode, or is not a contiguous tiling; keeps
 * the valid prefix when only its tail is torn.
 */
export async function loadFileIndex(
  logPath: string,
  ino: number,
  size: number,
): Promise<{
  readonly index: FileIndex
  /** True when the sidecar must be rewritten from `index` before appending. */
  readonly rewrite: boolean
}> {
  let raw: string
  try {
    raw = await fs.readFile(indexPathOf(logPath), 'utf8')
  } catch {
    return { index: { ino, blocks: [] }, rewrite: true }
  }
  const lines = raw.split('\n')
  const header = safeJson(lines[0] ?? '')
  const parsedHeader = IndexHeaderSchema.safeParse(header)
  if (!parsedHeader.success || parsedHeader.data.ino !== ino) {
    return { index: { ino, blocks: [] }, rewrite: true }
  }
  const blocks: IndexBlock[] = []
  let expected = 0
  let torn = false
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue
    const block = IndexBlockSchema.safeParse(safeJson(line))
    if (
      !block.success ||
      block.data.s !== expected ||
      block.data.e <= block.data.s ||
      block.data.e > size
    ) {
      torn = true
      break
    }
    blocks.push(block.data)
    expected = block.data.e
  }
  return { index: { ino, blocks }, rewrite: torn }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function rewriteSidecar(logPath: string, index: FileIndex): Promise<void> {
  const header = JSON.stringify({ v: INDEX_VERSION, ino: index.ino, block: BLOCK_BYTES })
  const body = index.blocks.map((b) => JSON.stringify(b)).join('\n')
  const tmp = `${indexPathOf(logPath)}.tmp`
  await fs.writeFile(tmp, body.length > 0 ? `${header}\n${body}\n` : `${header}\n`)
  await fs.rename(tmp, indexPathOf(logPath))
}

/** Something that yields between chunks so a reader on the same thread can run. */
export type Yield = () => Promise<void>

/**
 * Extend `index` over whatever complete lines were appended to the file since
 * its last completed block, persisting each block as it completes. Returns
 * the number of bytes read.
 */
export async function catchUpFileIndex(
  logPath: string,
  index: FileIndex,
  opts: {
    readonly rewrite: boolean
    readonly yieldFn?: Yield
    readonly shouldStop?: () => boolean
  },
): Promise<number> {
  if (opts.rewrite) await rewriteSidecar(logPath, index)
  const handle = await fs.open(logPath, 'r')
  try {
    const size = (await handle.stat()).size
    // `pos` is always a line start: the end of the last completed block, then
    // the start of the first incomplete line of the previous chunk.
    let pos = indexEnd(index)
    let builder = new BlockBuilder(pos)
    let readBytes = 0
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    while (pos < size) {
      if (opts.shouldStop?.() === true) break
      const { bytesRead } = await handle.read(buf, 0, Math.min(READ_CHUNK, size - pos), pos)
      if (bytesRead === 0) break
      readBytes += bytesRead
      const completed: IndexBlock[] = []
      let lineStart = 0
      for (;;) {
        const nl = buf.indexOf(0x0a, lineStart)
        if (nl === -1 || nl >= bytesRead) break
        builder.add(extractLineFacts(buf.toString('utf8', lineStart, nl)))
        lineStart = nl + 1
        const absolute = pos + lineStart
        if (absolute - builder.start >= BLOCK_BYTES) {
          const block = builder.finish(absolute)
          index.blocks.push(block)
          completed.push(block)
          builder = new BlockBuilder(absolute)
        }
      }
      if (completed.length > 0) {
        await fs.appendFile(
          indexPathOf(logPath),
          `${completed.map((b) => JSON.stringify(b)).join('\n')}\n`,
        )
      }
      if (lineStart === 0) {
        if (bytesRead < READ_CHUNK) break // the last line is still being written
        // One line longer than a chunk: its facts cannot be read whole, so the
        // block claims "anything" — a superset never hides a line.
        builder.addUnknown()
        pos += bytesRead
        continue
      }
      pos += lineStart
      await opts.yieldFn?.()
    }
    return readBytes
  } finally {
    await handle.close()
  }
}
