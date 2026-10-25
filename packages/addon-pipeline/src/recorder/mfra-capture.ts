/**
 * Capture a segment's sync-sample table at FINALIZE, while the file is still
 * in page cache, and keep it in RAM for the directory to serve.
 *
 * WHY AT FINALIZE
 * ───────────────
 * The tables are tiny (2–4 sync samples), but they are NOT in RAM: serving
 * them lazily from the read path would cost ~350 tail reads per hour per
 * camera on a contended array. At finalize the segment was written
 * milliseconds ago — both reads (a 4 KB head for the video track id, a 2 KB
 * tail for the `tfra`) come from page cache and cost microseconds.
 *
 * Rows finalized before this process booted have no table; the client falls
 * back to fetching the tail itself — same mechanism, one extra round trip.
 */
import { open } from 'node:fs/promises'
import { parseInitInfo } from './init-info.js'
import { parseMfra, DEFAULT_TAIL_BYTES, MfraParseError } from './mfra-index.js'
import type { SeededMfraTable } from './segment-directory.js'

/** Bytes of the head that reliably contain `ftyp` + `moov` (mirrors the client). */
const HEAD_BYTES = 4096

/**
 * Read `absPath`'s video sync-sample table. `fileBytes` is the segment's total
 * size (already stat-ed by the finalize path). Throws on a segment without a
 * parsable index — the caller records nothing and the client falls back.
 */
export async function readMfraTable(absPath: string, fileBytes: number): Promise<SeededMfraTable> {
  const fh = await open(absPath, 'r')
  try {
    const head = new Uint8Array(Math.min(HEAD_BYTES, fileBytes))
    await fh.read(head, 0, head.length, 0)
    const info = parseInitInfo(head)

    let tailLen = Math.min(DEFAULT_TAIL_BYTES, fileBytes)
    for (let attempt = 0; ; attempt++) {
      const tail = new Uint8Array(tailLen)
      await fh.read(tail, 0, tailLen, fileBytes - tailLen)
      try {
        const idx = parseMfra(tail, fileBytes, info === null ? {} : { trackId: info.videoTrackId })
        return { trackId: idx.trackId, mfraOffset: idx.mfraOffset, samples: idx.samples }
      } catch (err) {
        if (err instanceof MfraParseError && err.needBytes && attempt === 0) {
          tailLen = Math.min(err.needBytes + 64, fileBytes)
          continue
        }
        throw err
      }
    }
  } finally {
    await fh.close()
  }
}

/** How long a table stays served. Directory asks are for recent footage far
 *  more often than not, and a bounded window keeps this store O(day), not
 *  O(uptime): ~30 bytes a segment ⇒ a day across 20 cameras is a few MB. */
export const MFRA_RETAIN_MS = 26 * 3_600_000

/**
 * Whether a segment is recent enough for a captured table to ever be served.
 *
 * The gate the FINALIZE path must ask BEFORE reading the file. A live segment
 * always passes; a recovered one almost never does, and capturing it is pure
 * loss twice over — the table is unservable, and the read is a real `open` +
 * two `read`s on the libuv threadpool. The D148 boot reconcile fired 122 400 of
 * them, unawaited and unbounded, behind a 4-thread pool that the live
 * SegmentWriters' own finalize I/O has to share: that is the "segment file
 * never landed" (>30 s) on four cameras at once.
 */
export function isMfraTableServable(startMs: number, nowMs: number): boolean {
  return startMs >= nowMs - MFRA_RETAIN_MS
}

/** A `{ timeTicks, moofOffset }` object on a 64-bit V8 without pointer
 *  compression (Node): header + two fields + the array slot pointing at it,
 *  ~48 B, plus a 16 B HeapNumber when a value passes 2³¹. An ESTIMATE, rounded
 *  up — the order of magnitude is the point, not the byte. */
const MFRA_SAMPLE_APPROX_BYTES = 64

/** What {@link MfraTableStore.memoryCensus} reports. */
export interface MfraStoreCensus {
  readonly entries: number
  readonly samples: number
  readonly approxBytes: number
}

/**
 * The RAM store the directory reads. Keys are `(deviceId, profile, startMs)`
 * — exactly how a directory row identifies a segment. Insertion is
 * time-ordered (segments finalize as they are written), so pruning walks the
 * oldest entries only.
 */
export class MfraTableStore {
  private readonly tables = new Map<
    string,
    { readonly startMs: number; readonly table: SeededMfraTable }
  >()

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(deviceId: number, profile: string, startMs: number): string {
    return `${deviceId}:${profile}:${startMs}`
  }

  /**
   * Keep one table, unless it is already past the serve window.
   *
   * The out-of-window REJECT is not belt-and-braces: `prune` walks the
   * insertion-ordered prefix and stops at the first live entry, so an expired
   * entry appended AFTER a live one is never reachable again. A bulk recovery
   * appends 122 400 of exactly that shape and the store grows without bound.
   */
  record(deviceId: number, profile: string, startMs: number, table: SeededMfraTable): void {
    if (!isMfraTableServable(startMs, this.now())) return
    this.tables.set(this.key(deviceId, profile, startMs), { startMs, table })
    this.prune()
  }

  /**
   * The table for one directory row, or undefined (pre-boot segment / capture
   * failed / pruned). Eviction needs no hook here: a table only ever ATTACHES
   * to a row the directory scan actually found on disk, so a deleted segment's
   * entry is dead weight the TTL reclaims, never a wrong answer.
   */
  get(deviceId: number, profile: string, startMs: number): SeededMfraTable | undefined {
    return this.tables.get(this.key(deviceId, profile, startMs))?.table
  }

  get size(): number {
    return this.tables.size
  }

  /**
   * Entries and seek samples held, for the recorder census. The byte figure is
   * an ESTIMATE — {@link MFRA_SAMPLE_APPROX_BYTES} per sample object — and is
   * named as one; it is the order of magnitude that matters here.
   */
  memoryCensus(): MfraStoreCensus {
    let samples = 0
    for (const entry of this.tables.values()) samples += entry.table.samples.length
    return { entries: this.tables.size, samples, approxBytes: samples * MFRA_SAMPLE_APPROX_BYTES }
  }

  /** Insertion order is time order, so the expired prefix is contiguous. */
  private prune(): void {
    const cutoff = this.now() - MFRA_RETAIN_MS
    for (const [key, entry] of this.tables) {
      if (entry.startMs >= cutoff) break
      this.tables.delete(key)
    }
  }
}
