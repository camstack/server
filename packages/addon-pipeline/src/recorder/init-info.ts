/**
 * The two facts a byte-range read needs from a segment's `moov`, before it can
 * place a fragment anywhere in time: WHICH track is video, and at what
 * timescale its clock runs.
 *
 * Both are needed because a recorded segment carries two of everything. On the
 * live archive every segment has two `tfra` tables (video track 1 at timescale
 * 12800, audio track 2 at 8000) and two `trak` boxes. Choosing "the first one"
 * gives the right answer on this recorder and would give a silently wrong one
 * on any other — the audio timescale would stretch every offset by 1.6×, which
 * shows up as playback that drifts further the further you seek.
 *
 * PURE: bytes in, facts out. The bytes are the same `moov` prefix the decoder
 * is initialised with, so this costs no extra round trip.
 */

export interface InitInfo {
  readonly videoTrackId: number
  /** Ticks per second on the video track — the unit `tfra` sample times use. */
  readonly videoTimescale: number
  /**
   * Byte offset just past `moov` — where the decoder init ENDS.
   *
   * The head is read as a fixed block, which on a real segment overruns into
   * the first `moof`. Handing that overrun to the decoder along with some other
   * fragment gives it two fragments, the first of them truncated, and it
   * anchors on that one: every non-initial fragment then decodes as if it were
   * the segment's head. Callers must cut here.
   */
  readonly initEnd: number
}

/** Walk sibling boxes in [from, to), yielding [type, start, end]. */
function* boxes(
  buf: Uint8Array,
  view: DataView,
  from: number,
  to: number,
): Generator<[string, number, number]> {
  let p = from
  while (p + 8 <= to) {
    const size = view.getUint32(p)
    if (size < 8) return
    const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!)
    const end = p + size
    // A box that claims to run past what we were given means the caller handed
    // us a truncated read; stop rather than parse whatever follows in memory.
    if (end > to) return
    yield [type, p, end]
    p = end
  }
}

/** FullBox version byte sits right after the 8-byte box header. */
function versionOf(buf: Uint8Array, boxStart: number): number {
  return buf[boxStart + 8] ?? 0
}

/**
 * Parse `moov` for the video track's id and timescale.
 *
 * Returns null when the bytes hold no usable `moov` — a truncated read, or a
 * response that was not the segment head at all. The caller's answer to null is
 * to fall back to fetching the whole segment, which is slow but correct; a
 * guessed timescale would be fast and wrong.
 */
export function parseInitInfo(bytes: Uint8Array): InitInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (const [type, start, end] of boxes(bytes, view, 0, bytes.length)) {
    if (type !== 'moov') continue
    for (const [t2, s2, e2] of boxes(bytes, view, start + 8, end)) {
      if (t2 !== 'trak') continue
      const found = readTrak(bytes, view, s2, e2)
      if (found) return { ...found, initEnd: end }
    }
  }
  return null
}

/** A single `trak`: its id, its timescale, and whether it is the video one. */
function readTrak(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
): Omit<InitInfo, 'initEnd'> | null {
  let trackId: number | null = null
  let timescale: number | null = null
  let isVideo = false

  for (const [t3, s3, e3] of boxes(bytes, view, start + 8, end)) {
    if (t3 === 'tkhd') {
      // tkhd: version/flags(4) then creation+modification (8 or 16) then track_ID.
      trackId = view.getUint32(s3 + 12 + (versionOf(bytes, s3) === 1 ? 16 : 8))
    } else if (t3 === 'mdia') {
      for (const [t4, s4, e4] of boxes(bytes, view, s3 + 8, e3)) {
        if (t4 === 'mdhd') {
          // Same layout as tkhd up to the timescale field.
          timescale = view.getUint32(s4 + 12 + (versionOf(bytes, s4) === 1 ? 16 : 8))
        } else if (t4 === 'hdlr') {
          // hdlr: version/flags(4) + pre_defined(4) then the 4-char handler type.
          const h = s4 + 16
          if (h + 4 <= e4) {
            isVideo =
              String.fromCharCode(bytes[h]!, bytes[h + 1]!, bytes[h + 2]!, bytes[h + 3]!) === 'vide'
          }
        }
      }
    }
  }

  if (!isVideo || trackId === null || timescale === null || timescale <= 0) return null
  return { videoTrackId: trackId, videoTimescale: timescale }
}
