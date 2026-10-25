/**
 * Movie duration straight from MP4 bytes — the one fact the pacing check
 * (`pacing-check.ts`) needs from the finished export.
 *
 * A byte-walk and not an ffprobe, deliberately: the check runs on the hub
 * after every scheduled window against bytes `readExportBytes` already fetched
 * for publishing, and spawning a process to read two integers would be the
 * expensive way to be best-effort. The export engine writes `+faststart`, so
 * `moov` sits at the head of the file and the walk touches a few hundred bytes.
 *
 * Pure and total: any malformed, truncated or foreign input answers `null`,
 * never a throw — a garbled file is a *finding* for the caller to log, not an
 * exception to swallow.
 */

/** `moov`'s box type, and the child that carries the movie header. */
const BOX_HEADER_BYTES = 8

interface Mp4Box {
  readonly type: string
  /** Offset of the box's payload (after the size/type/largesize header). */
  readonly payloadStart: number
  /** Offset one past the box's last byte. */
  readonly end: number
}

/** Read the box starting at `at`, or null when the bytes cannot hold one. */
function readBox(view: DataView, at: number, limit: number): Mp4Box | null {
  if (at + BOX_HEADER_BYTES > limit) return null
  const size32 = view.getUint32(at)
  const type = String.fromCharCode(
    view.getUint8(at + 4),
    view.getUint8(at + 5),
    view.getUint8(at + 6),
    view.getUint8(at + 7),
  )
  let payloadStart = at + BOX_HEADER_BYTES
  let size: number
  if (size32 === 1) {
    // 64-bit largesize follows the type.
    if (at + 16 > limit) return null
    const large = view.getBigUint64(at + 8)
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(large)
    payloadStart = at + 16
  } else if (size32 === 0) {
    // "To end of file".
    size = limit - at
  } else {
    size = size32
  }
  const end = at + size
  if (size < BOX_HEADER_BYTES || end > limit) return null
  return { type, payloadStart, end }
}

/** The first child box of `type` inside [start, end). */
function findChild(view: DataView, start: number, end: number, type: string): Mp4Box | null {
  let at = start
  while (at < end) {
    const box = readBox(view, at, end)
    if (box === null) return null
    if (box.type === type) return box
    at = box.end
  }
  return null
}

/**
 * The movie duration in milliseconds, or null when the bytes do not carry one.
 *
 * Walks `moov` → `mvhd`, honouring both header versions (v0: 32-bit fields,
 * v1: 64-bit creation/modification/duration).
 */
export function readMp4DurationMs(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const moov = findChild(view, 0, bytes.byteLength, 'moov')
  if (moov === null) return null
  const mvhd = findChild(view, moov.payloadStart, moov.end, 'mvhd')
  if (mvhd === null) return null

  const p = mvhd.payloadStart
  if (p + 4 > mvhd.end) return null
  const version = view.getUint8(p)
  let timescale: number
  let duration: number
  if (version === 1) {
    // version+flags(4) creation(8) modification(8) timescale(4) duration(8)
    if (p + 32 > mvhd.end) return null
    timescale = view.getUint32(p + 20)
    const raw = view.getBigUint64(p + 24)
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null
    duration = Number(raw)
  } else {
    // version+flags(4) creation(4) modification(4) timescale(4) duration(4)
    if (p + 20 > mvhd.end) return null
    timescale = view.getUint32(p + 12)
    duration = view.getUint32(p + 16)
    // 0xFFFFFFFF is ISO BMFF's "duration unknown".
    if (duration === 0xffffffff) return null
  }
  if (timescale <= 0) return null
  return Math.round((duration / timescale) * 1000)
}
