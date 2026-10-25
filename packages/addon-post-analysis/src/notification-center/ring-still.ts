/**
 * A frame of a camera at a PAST instant, cut from its clip ring (D691).
 *
 * ## Why
 *
 * A became-free occupancy edge commits a sustain window after the subject
 * left, at best — and the live snapshot the still shelf used to take then is
 * the empty space. When the departure names a track that left, that track's
 * own best shot is the picture (`chooseDepartedMediaOwner`). When it cannot (a
 * parked entry retired on its strikes owns no track media), the only honest
 * picture is a frame from the moment it happened, and the one source holding
 * that moment in RAM is the broker's clip ring — which every camera an
 * occupancy rule follows holds for a full minute (`clip-retention-ask.ts`).
 *
 * ## How
 *
 * ONE ring cut (`streamBroker.renderPreBufferClip`, mp4, real time) of
 * ±{@link NC_RING_STILL_HALF_WINDOW_SEC} around the instant, and ONE frame
 * decoded {@link NC_RING_STILL_HALF_WINDOW_SEC} before the cut's END on the
 * PINNED ffmpeg (D540) — the end is the instant plus the post-roll, so that
 * frame is the instant itself, whatever key frame the cut had to start on.
 *
 * ## …and from the RECORDINGS when the ring has lost the moment (review M2)
 *
 * A rule with a long sustain (≳ 50 s), or a cheap profile past the ring's
 * byte cap (`CLIP_RING_MAX_BYTES`, ≈ 2.2 Mbps for a minute), commits after the
 * ring has dropped the departure. Exactly that moment is old enough for the
 * recordings to serve (their edge trails live by ~18–26 s), so the frame is
 * cut from ONE recorded export of the same ±1 s window (`cutRecordedClip`,
 * D686's 30 s bound handed down as its deadline) before the still gives up.
 * The export is trimmed to `[at − 1 s, at + 1 s]`, so the same `-sseof -1`
 * lands on the instant. A camera that does not record, or a window it did not
 * record, names both misses in the one error.
 *
 * ## Never silent
 *
 * Every miss THROWS with its reason. The caller is the still shelf, whose
 * `fetch` turns a throw into its tagged `the camera did not answer the
 * occupancy still` line; a `null` there would read as "no snapshot", which is
 * a different fault.
 */
import { type NcRecordedGifPorts } from './recorded-gif.js'

/** Seconds of ring on each side of the instant. One is enough for the
 *  decoder to reach a frame AT the instant without spending a GOP of memory. */
export const NC_RING_STILL_HALF_WINDOW_SEC = 1

/** Width the ring cut is muxed at — the shelf's own still envelope. */
export const NC_RING_STILL_MAX_WIDTH = 960

/** A recorded cut of the window, or the named reason there is none. */
export type NcRingStillRecorded =
  | { readonly ok: true; readonly mp4: Uint8Array }
  | { readonly ok: false; readonly reason: string }

/** What the cut reaches outside itself: the ring, the recordings, and the
 *  derive's ports. */
export interface NcRingStillPorts extends Omit<NcRecordedGifPorts, 'logger'> {
  /** The ring's mp4 around `aroundMs`, `halfWindowSec` on each side; `null`
   *  (or a throw) when the ring held nothing there. */
  readonly renderRingMp4: (
    deviceId: number,
    aroundMs: number,
    halfWindowSec: number,
  ) => Promise<Uint8Array | null>
  /** The same window from the RECORDINGS (review M2). Absent = no fallback. */
  readonly renderRecordedMp4?: (
    deviceId: number,
    aroundMs: number,
    halfWindowSec: number,
  ) => Promise<NcRingStillRecorded>
}

/** The shape the still shelf consumes. */
export interface NcRingStill {
  readonly base64: string
  readonly contentType: string
}

/** ffmpeg arguments: the frame one half-window before the end of `input`. */
export function ringStillArgs(input: string): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-sseof',
    `-${String(NC_RING_STILL_HALF_WINDOW_SEC)}`,
    '-i',
    input,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    'pipe:1',
  ]
}

const RING_EMPTY = 'the clip ring held no footage at that instant'

/** The ring's window, else the recordings', else a throw naming both misses. */
async function footageAt(
  ports: NcRingStillPorts,
  deviceId: number,
  atMs: number,
): Promise<Uint8Array> {
  let ringMiss: string
  try {
    const ring = await ports.renderRingMp4(deviceId, atMs, NC_RING_STILL_HALF_WINDOW_SEC)
    if (ring !== null && ring.byteLength > 0) return ring
    ringMiss = RING_EMPTY
  } catch (err) {
    ringMiss = err instanceof Error ? err.message : String(err)
  }
  const recorded = ports.renderRecordedMp4
  if (recorded === undefined) throw new Error(ringMiss)
  const cut = await recorded(deviceId, atMs, NC_RING_STILL_HALF_WINDOW_SEC)
  if (cut.ok && cut.mp4.byteLength > 0) return cut.mp4
  const recordedMiss = cut.ok ? 'empty recorded cut' : cut.reason
  throw new Error(`no frame at that instant — ring: ${ringMiss}; recordings: ${recordedMiss}`)
}

/** Cut the frame at `atMs`. Throws, by reason, on every miss. */
export async function cutRingStill(
  ports: NcRingStillPorts,
  deviceId: number,
  atMs: number,
): Promise<NcRingStill> {
  const mp4 = await footageAt(ports, deviceId, atMs)
  const file = await ports.writeTemp(mp4)
  try {
    const ran = await ports.run(await ports.resolveFfmpeg(), ringStillArgs(file))
    if (!ran.ok) throw new Error(`ring still decode failed: ${ran.error.slice(-300)}`)
    if (ran.stdout.byteLength === 0) throw new Error('ring still decode produced no bytes')
    return { base64: ran.stdout.toString('base64'), contentType: 'image/jpeg' }
  } finally {
    await ports.removeTemp(file)
  }
}
