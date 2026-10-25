/**
 * The sample index for a CLIP FILE, so a clip can be another position of the
 * recorded source pointer (D575).
 *
 * `RecordedFeeder` asks its byte source two questions — "is there a segment at
 * `epochMs`?" and "give me its bytes" — and the recorder answers both from the
 * segment's own `mfra`. A clip is a progressive `+faststart` MP4: it has a
 * `moov` at the FRONT and no `mfra` at all, so the time→sample map has to be
 * read out of `stbl` instead. That is what this module does, and it is the only
 * place in the clip path that parses MP4 structure.
 *
 * **It is a TIME index, not a byte index, and that is deliberate.** The
 * offsets in a progressive `moov` (`stco`/`stsc`) are absolute to the WHOLE
 * file, so a GOP-ranged slice of one is not a standalone-demuxable MP4 — making
 * it one means rewriting `stbl`, i.e. a remux. A clip arrives whole and
 * already compressed (one bounded by-handle fetch, D9/D18), so the file IS its
 * byte range, exactly as `RecordedFeederDeps.readGop` says of the playback
 * path. Parsing offsets nobody reads would be a leftover describing a design
 * this slice does not have.
 *
 * What the index IS for:
 * 1. **The gate.** A file with no usable sample table cannot join the recorded
 *    path, and is refused BY NAME rather than served as a zero-length
 *    timeline. Measured 2026-09-20: an HKSV clip has `mvhd.duration = 0`,
 *    `mdhd.duration = 0`, no `sidx` and no `mfra` — ffmpeg writes the trailer
 *    only on close and the tee cuts like a pipe.
 * 2. **The file-relative timeline.** `durationMs` is the segment span the
 *    feeder plays and the bound `ended` is decided on; `firstSyncMs` is where a
 *    seek before the first keyframe snaps to.
 */

const FOURCC_LENGTH = 4
const BOX_HEADER_LENGTH = 8
const LARGE_SIZE_HEADER_LENGTH = 16

/** One decoded sample on the clip's own timeline (0 = the first sample). */
export interface ClipSample {
  readonly startMs: number
  readonly durMs: number
  readonly sync: boolean
}

export interface ClipMp4Index {
  readonly kind: 'index'
  /** Total media duration in ms, summed from `stts` — never `mvhd.duration`,
   *  which an edit list can contradict and a trailer-less file leaves at 0. */
  readonly durationMs: number
  /** Time of the first sync sample. A seek before it cannot paint. */
  readonly firstSyncMs: number
  readonly syncSampleCount: number
  readonly samples: readonly ClipSample[]
}

/**
 * Why a file cannot join the recorded path. Every one of these is reported to
 * the operator and logged — a clip that silently plays nothing is the branch
 * this repo keeps paying for.
 */
export type ClipIndexRefusalReason = 'no-moov' | 'no-video-track' | 'no-samples' | 'malformed'

export interface ClipMp4IndexRefusal {
  readonly kind: 'refused'
  readonly reason: ClipIndexRefusalReason
}

export type ClipMp4IndexResult = ClipMp4Index | ClipMp4IndexRefusal

interface BoxSpan {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly contentStart: number
}

interface SttsRun {
  readonly count: number
  readonly delta: number
}

/**
 * Walk the direct children of `[start, end)`. Returns `null` when the region is
 * structurally impossible (a size that does not fit), which the caller turns
 * into `malformed` — never a throw, because these bytes come off a camera.
 */
function childBoxes(bytes: Uint8Array, start: number, end: number): BoxSpan[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: BoxSpan[] = []
  let off = start
  while (off + BOX_HEADER_LENGTH <= end) {
    const declared = view.getUint32(off)
    let type = ''
    for (let i = 0; i < FOURCC_LENGTH; i++) type += String.fromCharCode(bytes[off + 4 + i] ?? 0)
    let size = declared
    let contentStart = off + BOX_HEADER_LENGTH
    if (declared === 1) {
      if (off + LARGE_SIZE_HEADER_LENGTH > end) return null
      const hi = view.getUint32(off + 8)
      const lo = view.getUint32(off + 12)
      size = hi * 0x100000000 + lo
      contentStart = off + LARGE_SIZE_HEADER_LENGTH
    } else if (declared === 0) {
      size = end - off
    }
    if (size < contentStart - off) return null
    const boxEnd = off + size
    if (boxEnd > end) return null
    out.push({ type, start: off, end: boxEnd, contentStart })
    off = boxEnd
  }
  return out
}

function findBox(boxes: readonly BoxSpan[], type: string): BoxSpan | null {
  for (const b of boxes) if (b.type === type) return b
  return null
}

function readSttsRuns(bytes: Uint8Array, box: BoxSpan): readonly SttsRun[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const base = box.contentStart + 4
  if (base + 4 > box.end) return null
  const entries = view.getUint32(base)
  if (base + 4 + entries * 8 > box.end) return null
  const runs: SttsRun[] = []
  for (let i = 0; i < entries; i++) {
    const at = base + 4 + i * 8
    runs.push({ count: view.getUint32(at), delta: view.getUint32(at + 4) })
  }
  return runs
}

function readSyncSampleNumbers(bytes: Uint8Array, box: BoxSpan): ReadonlySet<number> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const base = box.contentStart + 4
  if (base + 4 > box.end) return null
  const entries = view.getUint32(base)
  if (base + 4 + entries * 4 > box.end) return null
  const out = new Set<number>()
  for (let i = 0; i < entries; i++) out.add(view.getUint32(base + 4 + i * 4))
  return out
}

function mediaTimescale(bytes: Uint8Array, mdhd: BoxSpan): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[mdhd.contentStart] ?? 0
  const at = mdhd.contentStart + 4 + (version === 1 ? 16 : 8)
  if (at + 4 > mdhd.end) return null
  const ts = view.getUint32(at)
  return ts > 0 ? ts : null
}

function handlerType(bytes: Uint8Array, hdlr: BoxSpan): string {
  const at = hdlr.contentStart + 8
  if (at + FOURCC_LENGTH > hdlr.end) return ''
  let out = ''
  for (let i = 0; i < FOURCC_LENGTH; i++) out += String.fromCharCode(bytes[at + i] ?? 0)
  return out
}

/** The video `trak` of a `moov`, or `null` when it has none. */
function videoTrack(bytes: Uint8Array, moov: BoxSpan): BoxSpan | null {
  const children = childBoxes(bytes, moov.contentStart, moov.end)
  if (!children) return null
  for (const trak of children) {
    if (trak.type !== 'trak') continue
    const trakKids = childBoxes(bytes, trak.contentStart, trak.end)
    const mdia = trakKids ? findBox(trakKids, 'mdia') : null
    if (!mdia) continue
    const mdiaKids = childBoxes(bytes, mdia.contentStart, mdia.end)
    const hdlr = mdiaKids ? findBox(mdiaKids, 'hdlr') : null
    if (hdlr && handlerType(bytes, hdlr) === 'vide') return mdia
  }
  return null
}

/**
 * Read a clip file's time→sample map. Never throws: every structural failure
 * comes back as a named refusal so the caller can say WHY a clip will not play.
 */
export function indexClipMp4(bytes: Uint8Array): ClipMp4IndexResult {
  const top = childBoxes(bytes, 0, bytes.length)
  if (!top) return { kind: 'refused', reason: 'malformed' }
  const moov = findBox(top, 'moov')
  if (!moov) return { kind: 'refused', reason: 'no-moov' }

  const mdia = videoTrack(bytes, moov)
  if (!mdia) return { kind: 'refused', reason: 'no-video-track' }

  const mdiaKids = childBoxes(bytes, mdia.contentStart, mdia.end)
  if (!mdiaKids) return { kind: 'refused', reason: 'malformed' }
  const mdhd = findBox(mdiaKids, 'mdhd')
  const minf = findBox(mdiaKids, 'minf')
  if (!mdhd || !minf) return { kind: 'refused', reason: 'malformed' }
  const timescale = mediaTimescale(bytes, mdhd)
  if (timescale === null) return { kind: 'refused', reason: 'malformed' }

  const minfKids = childBoxes(bytes, minf.contentStart, minf.end)
  const stbl = minfKids ? findBox(minfKids, 'stbl') : null
  if (!stbl) return { kind: 'refused', reason: 'no-samples' }
  const stblKids = childBoxes(bytes, stbl.contentStart, stbl.end)
  if (!stblKids) return { kind: 'refused', reason: 'malformed' }

  const sttsBox = findBox(stblKids, 'stts')
  if (!sttsBox) return { kind: 'refused', reason: 'no-samples' }
  const runs = readSttsRuns(bytes, sttsBox)
  if (!runs) return { kind: 'refused', reason: 'malformed' }

  const stssBox = findBox(stblKids, 'stss')
  // No `stss` means every sample is a sync sample (ISO/IEC 14496-12 8.6.2).
  const syncNumbers = stssBox === null ? null : readSyncSampleNumbers(bytes, stssBox)
  if (stssBox !== null && syncNumbers === null) return { kind: 'refused', reason: 'malformed' }

  const samples: ClipSample[] = []
  let ticks = 0
  let syncSampleCount = 0
  let firstSyncMs: number | null = null
  for (const run of runs) {
    for (let i = 0; i < run.count; i++) {
      const sampleNumber = samples.length + 1
      const sync = syncNumbers === null ? true : syncNumbers.has(sampleNumber)
      const startMs = (ticks * 1000) / timescale
      const durMs = (run.delta * 1000) / timescale
      if (sync) {
        syncSampleCount++
        if (firstSyncMs === null) firstSyncMs = startMs
      }
      samples.push({ startMs, durMs, sync })
      ticks += run.delta
    }
  }

  // A trailer-less file (an HKSV tee cut, `empty_moov`) lands here: the `moov`
  // parses, the sample table is present and EMPTY, and `mvhd`/`mdhd` say 0. It
  // is refused rather than served as a zero-length timeline.
  if (samples.length === 0 || ticks === 0) return { kind: 'refused', reason: 'no-samples' }

  return {
    kind: 'index',
    durationMs: (ticks * 1000) / timescale,
    firstSyncMs: firstSyncMs ?? 0,
    syncSampleCount,
    samples,
  }
}
