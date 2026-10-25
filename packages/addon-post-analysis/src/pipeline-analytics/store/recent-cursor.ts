/**
 * recent-cursor — pure helpers for the batched multi-device track listing
 * (`pipelineAnalytics.listRecentTracks`, TrackStore.queryRecent).
 *
 * Sort contract: the merged page is ordered by the stable total order
 * (`lastSeen` DESC, `trackId` DESC) — `lastSeen` is the recency key and the
 * trackId (the collection's primary key) breaks same-millisecond ties
 * deterministically. The continuation cursor encodes the LAST row of a page
 * as base64url JSON `{ l: lastSeen, i: trackId }`; the next page contains
 * exactly the rows strictly AFTER that position, i.e.
 * `lastSeen < l OR (lastSeen === l AND trackId < i)`.
 *
 * The cursor is OPAQUE to clients (encode/decode live only here) and stable:
 * both fields are immutable on a persisted track row, so re-running a page
 * against unchanged data yields byte-identical results, and newly persisted
 * tracks (which always sort ahead) can never shift already-consumed pages.
 */

export interface RecentCursor {
  readonly lastSeen: number
  readonly trackId: string
}

/** Row key used for ordering/merging (id = trackId primary key). */
export interface RecentSortKey {
  readonly lastSeen: number
  readonly id: string
}

export function encodeRecentCursor(cursor: RecentCursor): string {
  return Buffer.from(JSON.stringify({ l: cursor.lastSeen, i: cursor.trackId }), 'utf8').toString(
    'base64url',
  )
}

/**
 * Decode + validate an opaque cursor. Fails fast with a clear error on any
 * malformed input (bad base64, bad JSON, wrong field types) — a garbage
 * cursor must never silently degrade into a full-history first page.
 */
export function decodeRecentCursor(raw: string): RecentCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('listRecentTracks: malformed cursor')
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('l' in parsed) ||
    !('i' in parsed) ||
    typeof parsed.l !== 'number' ||
    !Number.isFinite(parsed.l) ||
    typeof parsed.i !== 'string' ||
    parsed.i.length === 0
  ) {
    throw new Error('listRecentTracks: malformed cursor')
  }
  return { lastSeen: parsed.l, trackId: parsed.i }
}

/** Comparator for the (lastSeen DESC, id DESC) total order. */
export function compareRecentDesc(a: RecentSortKey, b: RecentSortKey): number {
  if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/** True when `row` sits strictly AFTER the cursor position in DESC order
 *  (i.e. belongs to the next page). */
export function isAfterCursor(row: RecentSortKey, cursor: RecentCursor): boolean {
  if (row.lastSeen < cursor.lastSeen) return true
  return row.lastSeen === cursor.lastSeen && row.id < cursor.trackId
}
