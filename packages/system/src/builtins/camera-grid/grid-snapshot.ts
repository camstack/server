/**
 * A grid's snapshot — a frame of the COMPOSITION, never a dial.
 *
 * ## The decision, and the two things it rejects
 *
 * The operator: *"Lo snapshot possiamo sempre farlo dallo stream sempre, non
 * c'e' bisogno di comporre gli snapshots"* [we can always take the snapshot from the stream, there is no need to compose the snapshots]. So:
 *
 * - **Not composed from source snapshots.** That would be a SECOND compositor,
 *   with its own geometry, its own aspect handling and its own bugs, producing
 *   a picture that differs from the real one in ways nobody would ever notice
 *   until they mattered.
 * - **Not produced by starting the composition.** The whole of D519 is "a grid
 *   costs nothing when nobody watches". A thumbnail that dials N cameras — and
 *   on a battery camera, wakes one — spends the entire budget of the feature on
 *   a 160-pixel-wide picture in a list.
 *
 * ## The three states, all answered
 *
 * | state | answer |
 * | --- | --- |
 * | a composition is running | one frame sampled out of the bytes it is already emitting |
 * | nothing running, a frame was kept | that frame — stale, and honest about it |
 * | nothing running, nothing ever kept | `null`, logged with the reason |
 *
 * `null` is the courtesy card, which is the correct picture of "this grid has
 * never been watched". What it must never be is a reason to dial.
 *
 * ## Why this is a NATIVE snapshot provider
 *
 * The wrapper's ladder is native-first: a native that produces a frame
 * short-circuits before the broker frame-grab, and the broker frame-grab is the
 * thing that would wake the sources. A grid with a stored frame or a live
 * composition therefore never reaches it. The residual — a grid that has never
 * once been composed — is documented in D519; it cannot wake a battery camera,
 * because a grid never dials one live at all (`grid-sentry-sources.ts`).
 */
import { errMsg } from '@camstack/types'
import type { GridStreamLogger } from './grid-stream-session.js'

/** Where a grid's last composed frame is kept between compositions. */
export interface GridLastFrameStore {
  /** The last frame kept for this grid, or `null` — which is a real answer. */
  get(deviceId: number): Promise<Buffer | null>
  put(deviceId: number, jpeg: Buffer): Promise<void>
}

/** Just enough of a session for the snapshot to choose one and read its state. */
export interface GridSnapshotSession {
  isRunning(): boolean
}

export interface GridSnapshotAnswerInput {
  readonly running: boolean
  readonly hasStoredFrame: boolean
}

export type GridSnapshotAnswer =
  | { readonly kind: 'live' }
  | { readonly kind: 'stored' }
  | { readonly kind: 'none'; readonly reason: 'never-composed' }

/**
 * Which of the three answers applies. Pure, so the rule can be read — and
 * sabotaged — without a socket, a file or an ffmpeg.
 */
export function gridSnapshotAnswerFor(input: GridSnapshotAnswerInput): GridSnapshotAnswer {
  if (input.running) return { kind: 'live' }
  if (input.hasStoredFrame) return { kind: 'stored' }
  return { kind: 'none', reason: 'never-composed' }
}

export interface GridSnapshotImage {
  readonly base64: string
  readonly contentType: string
}

/**
 * Generic in the session type so the addon can hand over its OWN session
 * record — the one that also knows the instance and the stream — and get it
 * back in `sampleFrame` without a cast or a second lookup.
 */
export interface GridSnapshotDeps<S extends GridSnapshotSession = GridSnapshotSession> {
  readonly logger: GridStreamLogger
  /**
   * This grid's compositions — one, since the collapse to a single output.
   * Kept as a LIST because the choosing logic below is the same either way and
   * a list of one costs nothing. EMPTY means this addon does not own the
   * device — never "no picture".
   */
  readonly sessionsFor: (deviceId: number) => readonly S[]
  /**
   * One JPEG out of a composition that is ALREADY running. `null` when the
   * bytes could not be turned into a frame — which is a miss, not a reason to
   * start anything.
   */
  readonly sampleFrame: (session: S) => Promise<Buffer | null>
  readonly store: GridLastFrameStore
}

export class GridSnapshotSource<S extends GridSnapshotSession = GridSnapshotSession> {
  constructor(private readonly deps: GridSnapshotDeps<S>) {}

  async getSnapshot(deviceId: number): Promise<GridSnapshotImage | null> {
    const sessions = this.deps.sessionsFor(deviceId)
    if (sessions.length === 0) return null

    // The HIGHEST running composition. `sessionsFor` is ordered by quality, so
    // a live `mid` is taken over a dead `high` — the frame that EXISTS beats
    // the frame that would have been better.
    const live = sessions.find((session) => session.isRunning()) ?? null
    const stored = await this.readStored(deviceId)
    const answer = gridSnapshotAnswerFor({
      running: live !== null,
      hasStoredFrame: stored !== null,
    })

    if (answer.kind === 'live' && live !== null) {
      const sampled = await this.sample(deviceId, live)
      if (sampled !== null) {
        await this.keep(deviceId, sampled)
        return toImage(sampled)
      }
      // Sampling a running composition missed. That is a real failure and it is
      // named; the stored frame is still the best thing left, and starting
      // anything remains forbidden.
      if (stored !== null) return toImage(stored)
      this.deps.logger.warn(
        'camera grid: the composition is running but produced no frame, and none was kept',
        { tags: { deviceId } },
      )
      return null
    }

    if (answer.kind === 'stored' && stored !== null) return toImage(stored)

    // Accepted a request and produced nothing. Silence here reads as a broken
    // camera; the truth is that nobody has ever watched this grid, so there has
    // never been a composition to take a frame from.
    this.deps.logger.warn(
      'camera grid: no frame for this grid — nothing is composing it and none was ever kept',
      { tags: { deviceId }, meta: { reason: 'never-composed', compositions: sessions.length } },
    )
    return null
  }

  private async sample(deviceId: number, session: S): Promise<Buffer | null> {
    try {
      const jpeg = await this.deps.sampleFrame(session)
      if (jpeg !== null && jpeg.length > 0) return jpeg
      this.deps.logger.warn('camera grid: could not sample a frame from the live composition', {
        tags: { deviceId },
      })
      return null
    } catch (error) {
      this.deps.logger.warn('camera grid: could not sample a frame from the live composition', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
      return null
    }
  }

  private async readStored(deviceId: number): Promise<Buffer | null> {
    try {
      const jpeg = await this.deps.store.get(deviceId)
      return jpeg !== null && jpeg.length > 0 ? jpeg : null
    } catch (error) {
      // A store that cannot be read is UNKNOWN, not empty — but the only thing
      // this caller can do with unknown is the same thing it does with empty,
      // so it says which one it had.
      this.deps.logger.warn('camera grid: the kept frame could not be read', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
      return null
    }
  }

  private async keep(deviceId: number, jpeg: Buffer): Promise<void> {
    try {
      await this.deps.store.put(deviceId, jpeg)
    } catch (error) {
      // The caller already has its picture. A disk that refuses must never cost
      // a snapshot that succeeded — but it must not be silent either.
      this.deps.logger.warn('camera grid: the composed frame could not be kept', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
    }
  }
}

function toImage(jpeg: Buffer): GridSnapshotImage {
  return { base64: jpeg.toString('base64'), contentType: 'image/jpeg' }
}
