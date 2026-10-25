/**
 * `CSD1` — the wire format for segment discovery.
 *
 * WHAT IT REPLACES
 * ────────────────
 * The client asked "which segments cover this window" by fetching a synthesised
 * HLS master + variant playlist and parsing them back into exactly the triples
 * the server started with. Measured on the live hub for a 3,049-segment day:
 * 206 ms to synthesise, **1,745 ms to transfer and parse**. That is now the
 * dominant cost of opening recorded playback.
 *
 * WHY BINARY, AND WHY DELTAS
 * ──────────────────────────
 * A segment is three integers — start, duration, size — and its URL is a pure
 * function of them plus the path convention, so a row needs to carry no strings
 * at all. Starts are monotonic and about a segment-length apart, so the delta is
 * a small varint. Measured shape: ~7–8 bytes a row, so a camera-day is **~20 KB**
 * against a multi-thousand-line playlist.
 *
 * The decoder is exported for the round-trip test rather than only living in the
 * client: a format whose two halves are written twice is a format that drifts.
 */

/**
 * A segment's sync-sample table, captured at FINALIZE while the file was still
 * in page cache. Carried per row so a playback seek needs NO `mfra` tail fetch
 * — the client seeds its byte-range reader from this and goes straight to the
 * fragment. Rows finalized before the recorder booted have none; the client
 * falls back to the tail read for those, same mechanism, one extra round trip.
 */
export interface SeededMfraTable {
  /** The VIDEO track this table indexes (audio's tfra lists the same moofs on
   *  a different clock — seeding it would send seeks to non-keyframe bytes). */
  readonly trackId: number
  /** Byte offset where `mfra` begins — the upper bound of media data. */
  readonly mfraOffset: number
  readonly samples: readonly { readonly timeTicks: number; readonly moofOffset: number }[]
}

/** One segment, exactly as its filename states it. */
export interface DirectoryRow {
  readonly startMs: number
  readonly durMs: number
  readonly bytes: number
  /** Present only for segments finalized by the RUNNING recorder — see
   *  {@link SeededMfraTable}. */
  readonly mfra?: SeededMfraTable
}

export interface DirectoryPayload {
  /** The profile actually served — may differ from the one asked for. */
  readonly profile: string
  /** Whether the index had LOOKED at this window. `false` means "retry", and
   *  must never be presented to an operator as "no footage". */
  readonly hydrated: boolean
  /** Newest instant this answer accounts for; the client polls with it. */
  readonly asOfMs: number
  readonly rows: readonly DirectoryRow[]
}

/**
 * The playback data-plane's client path, shared with the embed so neither side
 * needs a round trip to DISCOVER it: the directory and the segment bytes both
 * live under `<path>/<deviceId>/…`, reverse-proxied by the hub. The recorder
 * addon asserts it serves at exactly this path.
 */
export const PLAYBACK_PLANE_PATH = '/addon/recorder/playback'

const MAGIC = 0x43534431 // 'CSD1'
/** v2 adds the optional per-row mfra table (a zero sample-count = absent).
 *  The decoder accepts both; the halves ship together in this package, so no
 *  deployed client ever sees a version it cannot read. */
const VERSION = 2

/** LEB128, unsigned. Every value here is a non-negative integer. */
function writeVarint(out: number[], value: number): void {
  let v = Math.max(0, Math.trunc(value))
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  let shift = 1
  let i = at
  for (;;) {
    const b = bytes[i]
    if (b === undefined) throw new Error('CSD1: truncated varint')
    value += (b & 0x7f) * shift
    i++
    if ((b & 0x80) === 0) break
    shift *= 128
    // A varint wider than 2^53 cannot be an epoch or a byte count; refuse it
    // rather than silently lose precision.
    if (shift > Number.MAX_SAFE_INTEGER) throw new Error('CSD1: varint out of range')
  }
  return { value, next: i }
}

/**
 * Encode a window of segments.
 *
 * `rows` MUST be ascending by `startMs` — the deltas are meaningless otherwise,
 * and a caller that hands over an unsorted list would produce a payload that
 * decodes into plausible nonsense.
 */
export function encodeDirectory(payload: DirectoryPayload): Uint8Array {
  const out: number[] = []
  // Header: magic and version as fixed bytes so a wrong endpoint is rejected
  // immediately rather than parsed as varints.
  out.push((MAGIC >>> 24) & 0xff, (MAGIC >>> 16) & 0xff, (MAGIC >>> 8) & 0xff, MAGIC & 0xff)
  out.push(VERSION)
  out.push(payload.hydrated ? 1 : 0)

  const profile = new TextEncoder().encode(payload.profile)
  writeVarint(out, profile.length)
  for (const b of profile) out.push(b)

  writeVarint(out, payload.asOfMs)
  writeVarint(out, payload.rows.length)

  let prevStart = 0
  for (const r of payload.rows) {
    // First row is absolute; the rest are deltas from the previous start.
    writeVarint(out, r.startMs - prevStart)
    writeVarint(out, r.durMs)
    writeVarint(out, r.bytes)
    prevStart = r.startMs
    // v2: the sync-sample table, 0-count when absent. Ticks and offsets are
    // ascending within a segment, so both delta-encode small.
    const mfra = r.mfra
    if (mfra === undefined || mfra.samples.length === 0) {
      writeVarint(out, 0)
      continue
    }
    writeVarint(out, mfra.samples.length)
    writeVarint(out, mfra.trackId)
    writeVarint(out, mfra.mfraOffset)
    let prevTicks = 0
    let prevMoof = 0
    for (const s of mfra.samples) {
      writeVarint(out, s.timeTicks - prevTicks)
      writeVarint(out, s.moofOffset - prevMoof)
      prevTicks = s.timeTicks
      prevMoof = s.moofOffset
    }
  }
  return Uint8Array.from(out)
}

export function decodeDirectory(bytes: Uint8Array): DirectoryPayload {
  if (bytes.length < 6) throw new Error('CSD1: too short')
  const magic =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
  if (magic >>> 0 !== MAGIC) throw new Error('CSD1: bad magic')
  const version = bytes[4]
  if (version !== 1 && version !== VERSION) {
    throw new Error(`CSD1: unsupported version ${String(version)}`)
  }
  const hydrated = bytes[5] === 1

  let at = 6
  const profileLen = readVarint(bytes, at)
  at = profileLen.next
  const profile = new TextDecoder().decode(bytes.subarray(at, at + profileLen.value))
  at += profileLen.value

  const asOf = readVarint(bytes, at)
  at = asOf.next
  const count = readVarint(bytes, at)
  at = count.next

  const rows: DirectoryRow[] = []
  let prevStart = 0
  for (let i = 0; i < count.value; i++) {
    const d = readVarint(bytes, at)
    at = d.next
    const dur = readVarint(bytes, at)
    at = dur.next
    const size = readVarint(bytes, at)
    at = size.next
    const startMs = prevStart + d.value
    prevStart = startMs

    let mfra: SeededMfraTable | undefined
    if (version === VERSION) {
      const sampleCount = readVarint(bytes, at)
      at = sampleCount.next
      if (sampleCount.value > 0) {
        const trackId = readVarint(bytes, at)
        at = trackId.next
        const mfraOffset = readVarint(bytes, at)
        at = mfraOffset.next
        const samples: { timeTicks: number; moofOffset: number }[] = []
        let prevTicks = 0
        let prevMoof = 0
        for (let s = 0; s < sampleCount.value; s++) {
          const ticks = readVarint(bytes, at)
          at = ticks.next
          const moof = readVarint(bytes, at)
          at = moof.next
          prevTicks += ticks.value
          prevMoof += moof.value
          samples.push({ timeTicks: prevTicks, moofOffset: prevMoof })
        }
        mfra = { trackId: trackId.value, mfraOffset: mfraOffset.value, samples }
      }
    }
    rows.push({ startMs, durMs: dur.value, bytes: size.value, ...(mfra ? { mfra } : {}) })
  }
  return { profile, hydrated, asOfMs: asOf.value, rows }
}
