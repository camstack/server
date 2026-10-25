/**
 * Pure paging logic for the server-served log history (D898).
 *
 * The server answers one TIME-BOUNDED slice per call: `done: false` with fewer
 * than `limit` entries means "the budget ran out, still searching". The client
 * keeps calling with `before: nextBefore` until it holds a full page, the
 * source says `done`, or the operator cancels. Kept free of React and tRPC so
 * the loop is unit-testable.
 */

export interface LogWireEntry {
  readonly id?: string
  readonly timestamp: string
  readonly level: string
  readonly message: string
  readonly scope?: string
  readonly tags?: Record<string, string | undefined>
  readonly meta?: Record<string, unknown>
}

export interface LogWirePage {
  /** NEWEST FIRST. */
  readonly entries: readonly LogWireEntry[]
  readonly nextBefore: string | null
  readonly nextAfter: string | null
  readonly scannedBytes: number
  readonly done: boolean
  readonly cancelled?: boolean
  readonly source: string
}

/** Fetches one slice older than `before` (undefined = the first page). */
export type FetchLogSlice = (
  before: string | undefined,
  remaining: number,
  signal: AbortSignal,
) => Promise<LogWirePage>

export interface CollectedPage {
  /** NEWEST FIRST, across every slice the loop made. */
  readonly entries: readonly LogWireEntry[]
  /** Cursor for the next older page; null when nothing older exists. */
  readonly nextBefore: string | null
  readonly done: boolean
  readonly cancelled: boolean
  readonly scannedBytes: number
  readonly source: string | undefined
}

export interface CollectPageOptions {
  readonly fetchSlice: FetchLogSlice
  readonly limit: number
  readonly before?: string
  readonly signal: AbortSignal
  /** Called after every slice with the bytes scanned so far. */
  readonly onProgress?: (scannedBytes: number) => void
}

/**
 * Accumulate slices until `limit` entries, `done`, or an abort. An abort keeps
 * what was already collected and the cursor reached, so "Load older" resumes
 * where the scan stopped instead of starting again.
 */
export async function collectPage(options: CollectPageOptions): Promise<CollectedPage> {
  const { fetchSlice, limit, signal, onProgress } = options
  const entries: LogWireEntry[] = []
  let cursor: string | undefined = options.before
  let scannedBytes = 0
  let source: string | undefined

  for (;;) {
    if (signal.aborted) {
      return {
        entries,
        nextBefore: cursor ?? null,
        done: false,
        cancelled: true,
        scannedBytes,
        source,
      }
    }
    let page: LogWirePage
    try {
      page = await fetchSlice(cursor, Math.max(1, limit - entries.length), signal)
    } catch (error) {
      if (signal.aborted) {
        return {
          entries,
          nextBefore: cursor ?? null,
          done: false,
          cancelled: true,
          scannedBytes,
          source,
        }
      }
      throw error
    }
    entries.push(...page.entries)
    scannedBytes += page.scannedBytes
    source = page.source
    onProgress?.(scannedBytes)

    const exhausted = page.done || page.nextBefore === null
    if (page.cancelled === true) {
      return {
        entries,
        nextBefore: page.nextBefore,
        done: exhausted,
        cancelled: true,
        scannedBytes,
        source,
      }
    }
    if (exhausted || entries.length >= limit) {
      return {
        entries,
        nextBefore: page.nextBefore,
        done: exhausted,
        cancelled: false,
        scannedBytes,
        source,
      }
    }
    cursor = page.nextBefore ?? undefined
  }
}

/** Stable identity of an entry: the server id, else the legacy composite key. */
export function logEntryKey(entry: LogWireEntry): string {
  if (entry.id !== undefined && entry.id !== '') return `id:${entry.id}`
  return `${entry.timestamp}|${entry.level}|${entry.scope ?? ''}|${entry.message}`
}

/**
 * History (newest first, as paged) merged with live entries (arrival order),
 * deduped by key — a live entry wins (richer tags/meta) — and returned
 * chronologically, newest LAST. Ties keep insertion order.
 */
export function mergeLogEntries(
  history: readonly LogWireEntry[],
  live: readonly LogWireEntry[],
): LogWireEntry[] {
  const byKey = new Map<string, LogWireEntry>()
  for (const entry of history) byKey.set(logEntryKey(entry), entry)
  for (const entry of live) byKey.set(logEntryKey(entry), entry)
  return [...byKey.values()].toSorted(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )
}
