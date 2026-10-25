/**
 * Paging through the hub's rotated log files (D898).
 *
 * Backward from a cursor (the default: from the newest line): newest file
 * first, newest block first. A block whose index rules the filter out is
 * SKIPPED without a read; inside a block that may match, a raw byte search
 * for the device / addon finds the candidate lines and only those are decoded
 * and parsed. The exact filter (`lineMatches`) then decides.
 *
 * Every read is a SLICE bounded by a wall-clock budget and a cancel check: it
 * stops at a line boundary and hands back the cursor it reached, so a scan of
 * thirty days is many short calls the client can stop at any time.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { LogReadEntry, LogReadQuery, LogReadResult } from '@camstack/types'
import {
  compileLogFilter,
  lineMatches,
  type CompiledLogFilter,
  type ReadableLine,
} from '../../logging/log-read-filter.js'
import {
  decodeFileCursor,
  encodeFileCursor,
  LOG_FILE_NAME_RE,
  type FileCursor,
} from './log-file-cursor.js'
import { indexEnd, type FileIndex, type IndexBlock } from './log-file-index.js'

export const DEFAULT_READ_LIMIT = 200
export const DEFAULT_BUDGET_MS = 1000
export const MAX_BUDGET_MS = 5000
/** Read granularity of a backward scan. */
const SCAN_CHUNK = 1024 * 1024

export interface FileReadStats {
  /** Blocks the index ruled out — never read. */
  blocksSkipped: number
  /** Blocks (or unindexed regions) actually read. */
  regionsRead: number
  /** Of those, INDEXED blocks — the ones the index could have skipped. */
  blocksRead: number
  /** Lines handed to JSON.parse. */
  linesParsed: number
}

export interface FileReadOutcome {
  readonly result: LogReadResult
  readonly stats: FileReadStats
}

export interface FileReadContext {
  readonly logsDir: string
  /** The file's index as far as it reaches (may be empty — then nothing is skipped). */
  readonly indexOf: (fileName: string) => Promise<FileIndex | null>
  readonly isCancelled: () => boolean
  readonly now?: () => number
}

/** What a reader can rule out from a block alone. */
export function blockMayMatch(block: IndexBlock, filter: CompiledLogFilter): boolean {
  if (block.l < filter.levelFloor) return false
  if (filter.until !== null && block.t0 !== null && block.t0 > filter.until) return false
  if (filter.since !== null && block.t1 !== null && block.t1 < filter.since) return false
  if (filter.deviceId !== null && block.d !== null && !block.d.includes(filter.deviceId))
    return false
  if (filter.addonId !== null && block.a !== null && !block.a.includes(filter.addonId)) return false
  if (filter.nodeId !== null && block.o !== null && !block.o.includes(filter.nodeId)) return false
  return true
}

/** The byte strings a matching raw line MUST contain (superset tests). */
function requiredNeedles(filter: CompiledLogFilter): Buffer[] {
  const needles: Buffer[] = []
  if (filter.deviceId !== null) needles.push(Buffer.from(`"deviceId":${String(filter.deviceId)}`))
  if (filter.addonId !== null) needles.push(Buffer.from(`"addonId":"${filter.addonId}`))
  return needles
}

/** A text needle that survives JSON escaping unchanged can pre-filter the raw line. */
function rawTextNeedle(filter: CompiledLogFilter): string | null {
  const text = filter.textLower
  if (text === null) return null
  // eslint-disable-next-line no-control-regex -- a control character is exactly what JSON escapes
  return /["\\\u0000-\u001f]/.test(text) ? null : text
}

/** Sorted occurrence positions of `needle` in `data`. */
function occurrences(data: Buffer, needle: Buffer, from: number): number[] {
  const out: number[] = []
  let at = data.indexOf(needle, from)
  while (at !== -1) {
    out.push(at)
    at = data.indexOf(needle, at + 1)
  }
  return out
}

interface ParsedRow {
  readonly entry: LogReadEntry
  readonly line: ReadableLine
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One JSON row → a read entry, or null for a line that is not one of ours. */
export function parseLogRow(text: string): ParsedRow | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const { level, message, timestamp, scope, id, tags, meta } = raw
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return null
  if (typeof message !== 'string' || typeof timestamp !== 'string') return null
  const ts = Date.parse(timestamp)
  if (!Number.isFinite(ts)) return null
  const cleanTags: Record<string, string | number> = {}
  if (isRecord(tags)) {
    for (const [key, value] of Object.entries(tags)) {
      if (typeof value === 'string' || typeof value === 'number') cleanTags[key] = value
    }
  }
  const hasTags = Object.keys(cleanTags).length > 0
  const scopeText = typeof scope === 'string' ? scope : undefined
  const metaRecord = isRecord(meta) ? meta : undefined
  const entry: LogReadEntry = {
    ...(typeof id === 'string' ? { id } : {}),
    timestamp: ts,
    level,
    ...(scopeText !== undefined ? { scope: scopeText } : {}),
    message,
    ...(hasTags ? { tags: cleanTags } : {}),
    ...(metaRecord !== undefined ? { meta: metaRecord } : {}),
  }
  return {
    entry,
    line: {
      timestamp: ts,
      level,
      message,
      scope: scopeText,
      tags: hasTags ? cleanTags : undefined,
      meta: metaRecord,
    },
  }
}

/** Daily files, newest first. */
export async function listLogFiles(logsDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(logsDir)
  } catch {
    return []
  }
  return names
    .filter((n) => LOG_FILE_NAME_RE.test(n))
    .toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

interface Region {
  readonly start: number
  readonly end: number
  readonly block: IndexBlock | null
}

/** Regions of [0, end), newest first: the unindexed tail, then the blocks. */
function regionsBackward(index: FileIndex | null, end: number): Region[] {
  const out: Region[] = []
  const indexed = index === null ? 0 : Math.min(indexEnd(index), end)
  if (end > indexed) out.push({ start: indexed, end, block: null })
  if (index !== null) {
    for (let i = index.blocks.length - 1; i >= 0; i -= 1) {
      const block = index.blocks[i]
      if (block === undefined || block.s >= end) continue
      out.push({ start: block.s, end: Math.min(block.e, end), block })
    }
  }
  return out
}

type LineVerdict = 'continue' | 'stop'

interface Scanner {
  readonly filter: CompiledLogFilter
  readonly needles: readonly Buffer[]
  readonly textNeedle: string | null
  readonly stats: FileReadStats
  scannedBytes: number
  readonly deadline: number
  readonly ctx: FileReadContext
}

function overBudget(s: Scanner): boolean {
  return s.ctx.isCancelled() || (s.ctx.now ?? Date.now)() >= s.deadline
}

/**
 * Scan [start, end) backward, calling `onLine` newest first with each line's
 * text and start offset. `end` must be a line start (or the end of the
 * complete data); a trailing partial line is ignored. Returns the start
 * offset of the oldest line examined, or `start` when the region is done.
 */
async function scanBackward(
  handle: fs.FileHandle,
  start: number,
  end: number,
  s: Scanner,
  onLine: (text: string, lineStart: number) => LineVerdict,
): Promise<{ readonly reached: number; readonly stopped: boolean }> {
  let hi = end
  let pending: Buffer = Buffer.alloc(0)
  let first = true
  while (hi > start) {
    const lo = Math.max(start, hi - SCAN_CHUNK)
    const chunk = Buffer.allocUnsafe(hi - lo)
    const { bytesRead } = await handle.read(chunk, 0, hi - lo, lo)
    s.scannedBytes += bytesRead
    let data =
      pending.length > 0
        ? Buffer.concat([chunk.subarray(0, bytesRead), pending])
        : chunk.subarray(0, bytesRead)
    if (first) {
      first = false
      const lastNl = data.lastIndexOf(0x0a)
      data = data.subarray(0, lastNl + 1)
      if (data.length === 0 && lo === start) return { reached: start, stopped: false }
    }
    let firstStart = 0
    if (lo !== start) {
      const nl = data.indexOf(0x0a)
      if (nl === -1 || nl === data.length - 1) {
        // No complete line starts inside this chunk: carry it whole.
        pending = Buffer.from(data)
        hi = lo
        continue
      }
      firstStart = nl + 1
    }
    const starts: number[] = []
    for (let p = firstStart; p < data.length; ) {
      starts.push(p)
      const nl = data.indexOf(0x0a, p)
      if (nl === -1) break
      p = nl + 1
    }
    // Candidate filter: every required needle must occur inside the line.
    const occ = s.needles.map((needle) => occurrences(data, needle, firstStart))
    const occPtr = occ.map((o) => o.length - 1)
    for (let k = starts.length - 1; k >= 0; k -= 1) {
      const ls = starts[k] ?? 0
      const le = (starts[k + 1] ?? data.length) - 1
      let candidate = true
      for (let n = 0; n < occ.length; n += 1) {
        const positions = occ[n] ?? []
        let ptr = occPtr[n] ?? -1
        while (ptr >= 0 && (positions[ptr] ?? 0) >= le) ptr -= 1
        occPtr[n] = ptr
        if (ptr < 0 || (positions[ptr] ?? -1) < ls) candidate = false
      }
      if (!candidate) continue
      const text = data.toString('utf8', ls, le)
      if (s.textNeedle !== null && !text.toLowerCase().includes(s.textNeedle)) continue
      if (onLine(text, lo + ls) === 'stop') return { reached: lo + ls, stopped: true }
    }
    pending = Buffer.from(data.subarray(0, firstStart))
    hi = lo
    const reached = lo + firstStart
    if (hi > start && overBudget(s)) return { reached, stopped: true }
  }
  return { reached: start, stopped: false }
}

/**
 * One backward slice. `entries` newest first; `nextBefore` resumes exactly
 * where this slice stopped.
 */
export async function readLogFilesBackward(
  ctx: FileReadContext,
  query: LogReadQuery,
): Promise<FileReadOutcome> {
  const filter = compileLogFilter(query)
  const limit = query.limit ?? DEFAULT_READ_LIMIT
  const budget = Math.min(query.budgetMs ?? DEFAULT_BUDGET_MS, MAX_BUDGET_MS)
  const s: Scanner = {
    filter,
    needles: requiredNeedles(filter),
    textNeedle: rawTextNeedle(filter),
    stats: { blocksSkipped: 0, regionsRead: 0, blocksRead: 0, linesParsed: 0 },
    scannedBytes: 0,
    deadline: (ctx.now ?? Date.now)() + budget,
    ctx,
  }
  const from: FileCursor | null = query.before !== undefined ? decodeFileCursor(query.before) : null
  const files = (await listLogFiles(ctx.logsDir)).filter((f) => from === null || f <= from.f)
  const entries: LogReadEntry[] = []
  let newestEnd: FileCursor | null = null

  const finish = (nextBefore: FileCursor | null, done: boolean): FileReadOutcome => ({
    result: {
      entries,
      nextBefore: nextBefore === null ? null : encodeFileCursor(nextBefore),
      nextAfter: newestEnd === null ? null : encodeFileCursor(newestEnd),
      scannedBytes: s.scannedBytes,
      done,
      ...(ctx.isCancelled() ? { cancelled: true } : {}),
    },
    stats: s.stats,
  })

  for (const file of files) {
    const filePath = path.join(ctx.logsDir, file)
    let size: number
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      continue // rotated away between the listing and now
    }
    const end = from !== null && file === from.f ? Math.min(from.o, size) : size
    const index = await ctx.indexOf(file)
    const handle = await fs.open(filePath, 'r')
    try {
      for (const region of regionsBackward(index, end)) {
        const block = region.block
        if (block !== null) {
          if (filter.since !== null && block.t1 !== null && block.t1 < filter.since) {
            return finish(null, true) // everything older is older still
          }
          if (!blockMayMatch(block, filter)) {
            s.stats.blocksSkipped += 1
            continue
          }
        }
        s.stats.regionsRead += 1
        if (block !== null) s.stats.blocksRead += 1
        let reachedSince = false
        const outcome = await scanBackward(
          handle,
          region.start,
          region.end,
          s,
          (text, lineStart) => {
            s.stats.linesParsed += 1
            const row = parseLogRow(text)
            if (row === null) return 'continue'
            if (filter.since !== null && row.line.timestamp < filter.since) {
              reachedSince = true
              return 'stop'
            }
            if (!lineMatches(row.line, filter)) return 'continue'
            // The newest match bounds `nextAfter`: everything after its line is
            // what a forward poll has not seen.
            if (newestEnd === null) {
              newestEnd = { f: file, o: lineStart + Buffer.byteLength(text, 'utf8') + 1 }
            }
            entries.push(row.entry)
            return entries.length >= limit ? 'stop' : 'continue'
          },
        )
        if (reachedSince) return finish(null, true)
        if (outcome.stopped) return finish({ f: file, o: outcome.reached }, false)
        if (overBudget(s)) return finish({ f: file, o: region.start }, false)
      }
    } finally {
      await handle.close()
    }
  }
  return finish(null, true)
}

/**
 * One forward slice: lines strictly after `after`, scanned oldest first and
 * returned newest first like every page. `nextAfter` is where the next poll
 * starts; `done` means the scan reached the end of the newest file.
 */
export async function readLogFilesForward(
  ctx: FileReadContext,
  query: LogReadQuery & { readonly after: string },
): Promise<FileReadOutcome> {
  const filter = compileLogFilter(query)
  const limit = query.limit ?? DEFAULT_READ_LIMIT
  const from = decodeFileCursor(query.after)
  const stats: FileReadStats = { blocksSkipped: 0, regionsRead: 0, blocksRead: 0, linesParsed: 0 }
  const files = (await listLogFiles(ctx.logsDir))
    .filter((f) => from === null || f >= from.f)
    .toReversed()
  const collected: LogReadEntry[] = []
  let scannedBytes = 0
  let oldestStart: FileCursor | null = null
  let reached: FileCursor | null = from
  let stoppedEarly = false
  const now = ctx.now ?? Date.now
  const deadline = now() + Math.min(query.budgetMs ?? DEFAULT_BUDGET_MS, MAX_BUDGET_MS)
  outer: for (const file of files) {
    const filePath = path.join(ctx.logsDir, file)
    let handle: fs.FileHandle
    try {
      handle = await fs.open(filePath, 'r')
    } catch {
      continue
    }
    try {
      const size = (await handle.stat()).size
      let pos = from !== null && file === from.f ? Math.min(from.o, size) : 0
      stats.regionsRead += 1
      const buf = Buffer.allocUnsafe(SCAN_CHUNK)
      while (pos < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(SCAN_CHUNK, size - pos), pos)
        if (bytesRead === 0) break
        scannedBytes += bytesRead
        let lineStart = 0
        for (;;) {
          const nl = buf.indexOf(0x0a, lineStart)
          if (nl === -1 || nl >= bytesRead) break
          const text = buf.toString('utf8', lineStart, nl)
          const absStart = pos + lineStart
          lineStart = nl + 1
          reached = { f: file, o: pos + lineStart }
          stats.linesParsed += 1
          const row = parseLogRow(text)
          if (row === null || !lineMatches(row.line, filter)) continue
          if (oldestStart === null) oldestStart = { f: file, o: absStart }
          collected.push(row.entry)
          if (collected.length >= limit) {
            stoppedEarly = true
            break outer
          }
        }
        if (lineStart === 0) break // a partial last line: wait for the writer
        pos += lineStart
        if (ctx.isCancelled() || now() >= deadline) {
          stoppedEarly = true
          break outer
        }
      }
    } finally {
      await handle.close()
    }
  }
  return {
    result: {
      entries: collected.toReversed(),
      nextBefore: oldestStart === null ? null : encodeFileCursor(oldestStart),
      nextAfter: reached === null ? null : encodeFileCursor(reached),
      scannedBytes,
      done: !stoppedEarly,
      ...(ctx.isCancelled() ? { cancelled: true } : {}),
    },
    stats,
  }
}
