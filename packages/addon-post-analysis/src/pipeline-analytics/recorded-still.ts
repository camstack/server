/**
 * R3 — recover a native frame by RE-DECODING it from the recording.
 *
 * ## What this is for
 *
 * 790 of 3 633 tracks over seven days (21.7%) ended with no `keyFrame`
 * ([D60](../../../../docs/decisions/adr-0060.md)). The embedding rebuild reads
 * the key frame and nothing else, so those tracks are outside semantic search —
 * and the note next to that number says the pixels are gone and there can be no
 * backfill.
 *
 * The pixels are not gone. The recorder runs `-c:v copy`, so **the recorded
 * frame IS the native frame**, and a wall-clock instant resolves to a single
 * GOP through the recorder's own mfra index. This module turns
 * `(deviceId, epochMs)` into one JPEG.
 *
 * ## The hard constraint, and how the shape enforces it
 *
 * **R3 must never slow a notification.** A GOP decode is hundreds of
 * milliseconds and contends with the recorder's own I/O; a delivery that waited
 * on one would trade a visible outcome for an invisible one. So this module is
 * reachable only from BACKGROUND passes — the embedding rebuild today — and
 * `scripts/check-recorded-still-off-delivery-path.ts` fails the build if a
 * delivery-path module imports it. The bound below (2 concurrent, a refusing
 * queue, a hard deadline) is the second line of defence, not the first: it
 * limits what a background pass can do to a node, while the guard is what keeps
 * the pass from being on a delivery's critical path at all.
 *
 * ## Why every refusal has its own name
 *
 * `no-footage` (the camera was not recording then), `not-covered` (a gap),
 * `busy` (the node is already doing two) and `decode-failed` have four
 * different fixes and one of them is "nothing, this is expected". A single
 * `null` would have made the 21.7% unattributable a second time.
 */
import type { IScopedLogger } from '@camstack/types'

/** Why a recovery produced no pixels — or that it did. */
export type RecoveredStillOutcome =
  | 'ok'
  /** The device has no recording configuration / profile to read from. */
  | 'no-recording'
  /** Recording exists, but nothing covers that instant (motion-band gap, pruned). */
  | 'no-footage'
  /** The node is already running its bound of decodes; the caller may retry later. */
  | 'busy'
  /** Bytes were located and the decode still produced nothing. */
  | 'decode-failed'

/** One recovery attempt's result. `jpeg` is present iff `outcome === 'ok'`. */
export interface RecoveredStill {
  readonly outcome: RecoveredStillOutcome
  readonly jpeg?: Buffer
  /** Absolute epoch ms of the GOP the frame was taken from — the honest time. */
  readonly gopStartMs?: number
}

/** The GOP bytes the recorder answers with, plus where they sit in wall time. */
export interface RecordedGop {
  readonly data: Uint8Array
  readonly gopStartMs: number
  readonly gopDurMs: number
}

/**
 * The recorder read surface this module needs, named as a port so the whole
 * module is testable without a recorder, a disk or ffmpeg.
 *
 * READ-SIDE ONLY, deliberately: nothing here touches the writer, the eviction
 * or the relief paths.
 */
export interface RecordedStillPorts {
  readonly logger: IScopedLogger
  /** The profile to read (`high` where it exists). `null` ⇒ not recording. */
  readonly resolveProfile: (deviceId: number) => Promise<string | null>
  /** Does footage cover this instant? `false` ⇒ a gap or pruned. */
  readonly locate: (
    deviceId: number,
    profile: string,
    epochMs: number,
  ) => Promise<{ readonly startMs: number } | null>
  /** The single GOP covering `epochMs`, by mfra byte range. */
  readonly readGop: (
    deviceId: number,
    profile: string,
    startMs: number,
    epochMs: number,
  ) => Promise<RecordedGop | null>
  /** Decode ONE frame `atSec` into the fragment; `null` on any failure. */
  readonly decodeStill: (gop: Uint8Array, atSec: number, maxWidth: number) => Promise<Buffer | null>
}

/**
 * Concurrent decodes per node.
 *
 * Two, not "a few": this runs on a node that is also decoding live streams and
 * writing recordings, and the work it serves is a maintenance pass with no
 * deadline. `StillFrameService` (the recorder's export-dialog still) ships 3
 * for an interactive request; a background pass has less claim than a dialog.
 */
const RECORDED_STILL_MAX_CONCURRENT = 2

/**
 * Where inside its GOP the wanted frame sits, in seconds.
 *
 * Clamped into the fragment: a request whose instant lands outside the GOP the
 * recorder returned takes the nearest edge rather than seeking past the end and
 * getting nothing. The clamp is honest because the caller is told
 * {@link RecoveredStill.gopStartMs} and can see the offset it actually got.
 */
export function stillSeekSec(epochMs: number, gop: RecordedGop): number {
  const offsetMs = epochMs - gop.gopStartMs
  const maxMs = Math.max(0, gop.gopDurMs - 1)
  return Math.min(Math.max(0, offsetMs), maxMs) / 1000
}

/**
 * ffmpeg argv for "one JPEG at `atSec` from this fMP4 fragment, on stdout".
 *
 * `-ss` goes AFTER `-i` on purpose — the inverse of the timelapse preview's
 * choice, and for the inverse reason. The input is a PIPE (the fragment never
 * touches disk: it is ~200 KB and staging it would add an fs round trip to a
 * path that already has a deadline), and an input seek on a non-seekable pipe
 * is unreliable. The fragment is ONE GOP, so an output seek decodes at most a
 * keyframe interval — the thing that makes an output seek expensive on a whole
 * file does not apply here.
 */
export function buildRecordedStillArgs(atSec: number, maxWidth: number): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    'pipe:0',
    '-ss',
    String(Math.max(0, atSec)),
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${maxWidth},iw)':-2`,
    '-f',
    'image2',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]
}

/**
 * Recover the native frame nearest `epochMs` for `deviceId`.
 *
 * Never throws: every failure is an outcome, because the caller's next move
 * differs by outcome and an exception would collapse four of them into one.
 * The cheap questions come first — profile, then coverage, then bytes, then the
 * decode — so a camera that was not recording costs a settings read and not a
 * disk read (the same ordering rule `runStatelessStep` follows for stored
 * media, [D56](../../../../docs/decisions/adr-0056.md)).
 */
export class RecordedStillService {
  private inFlight = 0

  constructor(
    private readonly ports: RecordedStillPorts,
    private readonly maxConcurrent: number = RECORDED_STILL_MAX_CONCURRENT,
  ) {}

  /** Decodes currently running (tests / metrics). */
  get running(): number {
    return this.inFlight
  }

  async recover(deviceId: number, epochMs: number, maxWidth: number): Promise<RecoveredStill> {
    const tags = { deviceId }
    // REFUSE rather than queue. A queue here would turn a bounded maintenance
    // pass into an unbounded backlog of work whose value decays, and the caller
    // (a pass that walks thousands of tracks) can simply come back.
    if (this.inFlight >= this.maxConcurrent) {
      this.ports.logger.debug('recorded still refused: node already at its decode bound', {
        tags,
        meta: { epochMs, inFlight: this.inFlight },
      })
      return { outcome: 'busy' }
    }
    this.inFlight += 1
    try {
      const profile = await this.ports.resolveProfile(deviceId)
      if (profile === null) {
        this.ports.logger.debug('recorded still unavailable: camera is not recording', {
          tags,
          meta: { epochMs },
        })
        return { outcome: 'no-recording' }
      }
      const located = await this.ports.locate(deviceId, profile, epochMs)
      if (located === null) {
        this.ports.logger.debug('recorded still unavailable: no footage covers that instant', {
          tags,
          meta: { epochMs, profile },
        })
        return { outcome: 'no-footage' }
      }
      const gop = await this.ports.readGop(deviceId, profile, located.startMs, epochMs)
      if (gop === null || gop.data.byteLength === 0) {
        this.ports.logger.warn('recorded still: the GOP read produced no bytes', {
          tags,
          meta: { epochMs, profile, startMs: located.startMs },
        })
        return { outcome: 'no-footage' }
      }
      const jpeg = await this.ports.decodeStill(gop.data, stillSeekSec(epochMs, gop), maxWidth)
      if (jpeg === null || jpeg.byteLength === 0) {
        // A branch that drops work says so. This one is the difference between
        // "the footage is not there" and "the footage is there and we cannot
        // read it", which are not the same problem.
        this.ports.logger.warn('recorded still: GOP located but the decode produced nothing', {
          tags,
          meta: { epochMs, profile, gopStartMs: gop.gopStartMs, bytes: gop.data.byteLength },
        })
        return { outcome: 'decode-failed' }
      }
      return { outcome: 'ok', jpeg, gopStartMs: gop.gopStartMs }
    } catch (err: unknown) {
      this.ports.logger.warn('recorded still failed', {
        tags,
        meta: { epochMs, error: err instanceof Error ? err.message : String(err) },
      })
      return { outcome: 'decode-failed' }
    } finally {
      this.inFlight -= 1
    }
  }
}
