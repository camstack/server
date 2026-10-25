/**
 * The seam between the delegate and the disk: one {@link HksvClipStore} plus
 * one {@link HksvClipWriter} per HomeKit recording.
 *
 * ## Why the handle is synchronous and the work is not
 *
 * `HksvRecordingDelegate` is yielding fragments to the operator's real home
 * while this runs. It must not await a `mkdir`, an `open`, an ffmpeg or a
 * prune, so `ClipTee` is a handle returned immediately and every awaited step
 * happens behind it. The subscription the delegate already opened is the only
 * thing handed over, and it is a queue of its own on the plane — what happens
 * here cannot reach HomeKit's stream.
 *
 * The window between `subscribe` and the file being open is covered by that
 * subscription's queue (2 fragments plus its prebuffer replay). A fragment
 * cadence is 4-8 s and a `mkdir` is sub-millisecond, so the queue is never the
 * thing that closes; and if it ever were, the plane closes THIS subscriber and
 * the clip is a truncated clip — never a gapped one, and never HomeKit's
 * problem.
 *
 * ## What a later slice consumes
 *
 * Nothing here knows about `videoclips`, the per-device wrapper mount or the
 * collection fan-out (D549 § 3, slices 1 and 6) — those are framework work
 * another slice owns, and `export-hap` is hub-only in its own runner. What they
 * will find when they land: `HksvClipStore.listRecords(deviceId)` returning
 * `HksvClipRecord`s with self-contained ids, vouched thumbnails and honest
 * absences, under the declared `homekitClips` location
 * (`<root>/homekit-clips/<deviceId>/`, `clip-location.ts`).
 */
import type { CamProfile, IScopedLogger } from '@camstack/types'

import type { HksvClipStore } from './clip-store.js'
import { HksvClipWriter } from './clip-writer.js'
import type { ClipTee, ClipTeeFactory, ClipTeeRequest } from './recording-delegate.js'

export interface HksvClipTeeInput {
  readonly logger: IScopedLogger
  readonly deviceId: number
  readonly store: HksvClipStore
  /** The slot the recording child is copying — recorded on every clip. */
  readonly width: number
  readonly height: number
  readonly fragmentMs: number
  /** The slot `pickRecordingSource` chose, recorded on every clip it tees. */
  readonly profile?: CamProfile
  readonly now?: () => number
}

export function createClipTeeFactory(input: HksvClipTeeInput): ClipTeeFactory {
  return (request) => new ClipTeeRunner(input, request)
}

class ClipTeeRunner implements ClipTee {
  private writer: HksvClipWriter | null = null
  /** `finish()` arriving before the file is open — the short stream case. */
  private finishPending = false
  private acknowledgePending = false
  private clipId: string | null = null
  private readonly completed: Promise<void>

  constructor(
    private readonly input: HksvClipTeeInput,
    private readonly request: ClipTeeRequest,
  ) {
    this.completed = this.run()
  }

  finish(): void {
    this.finishPending = true
    this.writer?.finish()
  }

  acknowledge(): void {
    this.acknowledgePending = true
    void this.completed.then(() => this.persistAcknowledgement())
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const { store, deviceId } = this.input
    const now = this.input.now ?? Date.now
    const tags = { deviceId }
    const open = await store.open({
      deviceId,
      streamId: this.request.streamId,
      startedAtMs: now(),
      prebufferSpanMs: this.request.prebufferSpanMs,
      width: this.input.width,
      height: this.input.height,
      fragmentMs: this.input.fragmentMs,
      ...(this.input.profile === undefined ? {} : { profile: this.input.profile }),
    })
    if (open === null) {
      // The store already said why. Let the subscription go rather than leave
      // it filling on a plane that is feeding HomeKit.
      this.request.subscription.release()
      return
    }
    this.clipId = open.clipId
    const writer = new HksvClipWriter({
      logger: this.input.logger,
      deviceId,
      streamId: this.request.streamId,
      subscription: this.request.subscription,
      sink: open.sink,
      maxBytes: store.maxClipBytes,
      now,
    })
    this.writer = writer
    writer.start()
    // The stream may have ended while the file was being opened.
    if (this.finishPending) writer.finish()
    const outcome = await writer.done
    try {
      await open.complete(outcome)
    } catch (err) {
      this.input.logger.warn('hksv clip tee: the clip could not be completed', {
        tags,
        meta: {
          streamId: this.request.streamId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  private async persistAcknowledgement(): Promise<void> {
    const clipId = this.clipId
    if (clipId === null || !this.acknowledgePending) return
    this.acknowledgePending = false
    try {
      await this.input.store.acknowledge(this.input.deviceId, clipId)
    } catch (err) {
      this.input.logger.warn('hksv clip tee: recording the acknowledgement failed', {
        tags: { deviceId: this.input.deviceId },
        meta: { clipId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
