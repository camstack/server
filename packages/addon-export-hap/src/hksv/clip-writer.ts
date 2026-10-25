/**
 * `HksvClipWriter` — the TEE. One `Fmp4FragmentPlane` subscription beside the
 * delegate's own, writing `init + fragments` to a file so a clip HomeKit kept
 * is also a clip CamStack kept.
 *
 * ## Why a tee and not a fetch
 *
 * HomeKit Secure Video is a sink. HDS `dataSend` is push-only and
 * `CameraRecordingDelegate` has no read-back — a clip iOS stored is never
 * readable by the accessory again, from HomeKit or from iCloud. So the only
 * copy CamStack can ever have of a HomeKit clip is the one it kept of what it
 * SENT, at the moment it sent it. A stream you did not tee is gone; that is why
 * this is not waiting for the provider slices that will list it.
 *
 * ## The constraint that outranks the feature
 *
 * The plane this subscribes to is feeding the operator's real home. **The tee
 * must never block, slow or fail the delegate's own subscription.** Three
 * things make that true, and each is tested against a real plane:
 *
 *  - **It is a SEPARATE subscription.** `Fmp4FragmentPlane` fans out per
 *    subscriber with an independent queue; closing one (D80 closes a slow
 *    consumer rather than gapping it) touches no other. The delegate's stream
 *    is therefore unreachable from here by construction — not by care.
 *  - **Nothing it does is awaited by the delegate.** `start()` launches the
 *    loop and returns; `finish()` releases and returns. The delegate's
 *    generator never awaits a disk write.
 *  - **Every failure is an OUTCOME, never a throw.** A write that throws, a
 *    ceiling that is reached, a plane that closed it — each ends the clip with
 *    a named {@link HksvClipTruncation} and a warn carrying `deviceId`, and
 *    the HKSV recording continues untouched. `done` never rejects.
 *
 * ## The bounds
 *
 * RAM: the plane hands every subscriber the SAME `Uint8Array` (no copy), so a
 * tee that keeps pace costs nothing over the delegate. What it can cost is a
 * tee that falls behind holding fragments the delegate has already released —
 * bounded at {@link CLIP_TEE_QUEUE_CAPACITY} fragments plus the prebuffer
 * replay, which the ring's own 16 MB ceiling already bounds. Two, not four:
 * a tee is not a live consumer with a deadline, and a disk that is two
 * fragments (8-16 s) behind is pathological — a truncated clip is the right
 * answer there, and an unbounded queue is how this repo OOM'd hub-main (D9/D18).
 *
 * Disk: {@link HksvClipWriterInput.maxBytes} per clip. A clip's duration is
 * whatever iOS pulled — prebuffer plus however long the hub kept the stream
 * open — and that is not a window we choose, so it is the one thing here that
 * has no natural ceiling. This is the ceiling.
 */
import type { IScopedLogger } from '@camstack/types'
import type { Fmp4Subscription } from '@camstack/types/node'

import type { HksvClipTruncation } from './clip-record.js'

/**
 * How far the tee may fall behind before the plane closes it. See the docblock:
 * two fragments of slack, never more, because the cost of more is RAM in the
 * exporter's runner and the cost of less is a truncated clip nobody was
 * waiting for.
 */
export const CLIP_TEE_QUEUE_CAPACITY = 2

/**
 * Where the bytes go. An interface rather than a stream, so the contract tests
 * can drive a sink that throws — the whole point being that they then assert
 * the DELEGATE's stream is unchanged, which a mocked plane could not show.
 */
export interface ClipSink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface ClipWriteOutcome {
  readonly bytes: number
  /** Media fragments written. The init segment is not one of them. */
  readonly fragments: number
  /** False means the file is undecodable — no `ftyp`/`moov` ever arrived. */
  readonly sawInit: boolean
  readonly truncated: HksvClipTruncation | null
  readonly startedAtMs: number
  readonly endedAtMs: number
}

export interface HksvClipWriterInput {
  readonly logger: IScopedLogger
  readonly deviceId: number
  readonly streamId: number
  readonly subscription: Fmp4Subscription
  readonly sink: ClipSink
  /** The per-clip ceiling. Reaching it truncates the clip, named. */
  readonly maxBytes: number
  readonly now: () => number
}

export class HksvClipWriter {
  private readonly log: IScopedLogger
  private started = false
  private settle: ((outcome: ClipWriteOutcome) => void) | null = null
  private readonly outcome: Promise<ClipWriteOutcome>
  private bytes = 0
  private fragments = 0
  private sawInit = false
  private truncated: HksvClipTruncation | null = null
  private readonly startedAtMs: number

  constructor(private readonly input: HksvClipWriterInput) {
    this.log = input.logger
    this.startedAtMs = input.now()
    this.outcome = new Promise<ClipWriteOutcome>((resolve) => {
      this.settle = resolve
    })
  }

  /** Resolves once the file is closed. NEVER rejects — every failure is named. */
  get done(): Promise<ClipWriteOutcome> {
    return this.outcome
  }

  /** Launch the loop. Returns immediately: the delegate awaits nothing here. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  /**
   * The HDS stream ended. Releases the subscription, which drains whatever is
   * already queued and then completes the loop. Idempotent, synchronous, and
   * safe to call from the delegate's `finally`.
   */
  finish(): void {
    this.input.subscription.release()
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const { subscription, sink } = this.input
    const tags = { deviceId: this.input.deviceId }
    try {
      for await (const packet of subscription.packets()) {
        if (packet.data.length === 0) continue
        if (this.bytes + packet.data.length > this.input.maxBytes) {
          // An iOS session that never closes is the only way here. Stop, name
          // it, keep what landed: a truncated clip is a clip, a runaway file
          // is a disk.
          this.truncated = 'size-cap'
          this.log.warn('hksv clip tee: the per-clip size ceiling was reached — TRUNCATING', {
            tags,
            meta: {
              streamId: this.input.streamId,
              bytes: this.bytes,
              maxBytes: this.input.maxBytes,
              fragments: this.fragments,
            },
          })
          break
        }
        await sink.write(packet.data)
        this.bytes += packet.data.length
        if (packet.kind === 'init') this.sawInit = true
        else this.fragments += 1
      }
      // The plane closed this subscriber for falling behind. D80: closed, never
      // gapped — so what landed is a shorter clip, not a corrupt one, and the
      // operator is told which cameras cannot keep up with their own disk.
      if (this.truncated === null && subscription.closedReason === 'slow-consumer') {
        this.truncated = 'slow-consumer'
        this.log.warn(
          'hksv clip tee: the plane closed the tee for falling behind — the clip is TRUNCATED (HomeKit recording unaffected)',
          {
            tags,
            meta: {
              streamId: this.input.streamId,
              bytes: this.bytes,
              fragments: this.fragments,
            },
          },
        )
      }
    } catch (err) {
      // The disk, not HomeKit. Logged and contained: the delegate's own
      // subscription is a different queue on the same plane and is untouched.
      this.truncated = 'write-failed'
      this.log.warn(
        'hksv clip tee: writing the clip FAILED — the HomeKit recording is unaffected',
        {
          tags,
          meta: {
            streamId: this.input.streamId,
            bytes: this.bytes,
            fragments: this.fragments,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
    } finally {
      // Always, in both directions: a subscription left open would keep filling
      // until the plane closed it as a slow consumer, and a sink left open
      // would leak a file descriptor per recording.
      subscription.release()
      try {
        await sink.close()
      } catch (err) {
        if (this.truncated === null) this.truncated = 'write-failed'
        this.log.warn('hksv clip tee: closing the clip file failed', {
          tags,
          meta: {
            streamId: this.input.streamId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
      this.resolve()
    }
  }

  private resolve(): void {
    const settle = this.settle
    this.settle = null
    settle?.({
      bytes: this.bytes,
      fragments: this.fragments,
      sawInit: this.sawInit,
      truncated: this.truncated,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.input.now(),
    })
  }
}
