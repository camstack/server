/**
 * The ONE production trigger for silent cameras (D683 §6.4, review C2): every
 * `TTL_SWEEP_INTERVAL_MS` the addon's sweep runs this BEFORE the track closer,
 * so a camera whose frames stopped still ends its tracklets and commits its
 * fusions, and the closer asks `canClose` in the processor's own frame clock.
 */
import type { IScopedLogger } from '@camstack/types'
import type { TrackFusion } from './tracker-v2/index.js'

/**
 * The addon's close-sweep period (`sweepExpiredTracks`). A silent camera's L2
 * steps only this often, which is why `LINK_WINDOW_MS` budgets one period
 * (`tracker-v2/__tests__/constants.spec.ts` imports it from here).
 */
export const TTL_SWEEP_INTERVAL_MS = 5_000

/** What the sweep needs of a `FrameProcessor` — its frame clock and liveness. */
export interface SweepableProcessor {
  readonly deviceId: number
  advanceBySilence(wallNow: number): readonly TrackFusion[]
  frameNow(wallNow: number): number | null
  isLive(trackId: string): boolean
  isTailFinal(trackId: string, frameT: number): boolean
}

export interface TrackerSweepDeps {
  /** Every processor, keyed as the addon keys them (`deviceId:source`). */
  readonly processors: () => Iterable<readonly [string, SweepableProcessor]>
  /** The processors of one camera that exist (`pipeline` / `onboard`). */
  readonly processorsOf: (deviceId: number) => readonly SweepableProcessor[]
  readonly applyFusions: (
    deviceId: number,
    key: string,
    fusions: readonly TrackFusion[],
  ) => Promise<void>
  /** Where a processor whose advance threw is reported (review H3). */
  readonly logger: IScopedLogger
}

export interface SweptTrack {
  readonly deviceId: number
  readonly trackId: string
}

export class TrackerSweep {
  constructor(private readonly deps: TrackerSweepDeps) {}

  /**
   * Advance every processor by the silence since its last frame. One
   * processor's failure is contained to that processor (review H3): it is
   * logged with its camera, and every other camera still advances — a throw
   * here must never starve the sweep of the cameras after it.
   */
  async run(wallNow: number): Promise<void> {
    for (const [key, processor] of this.deps.processors()) {
      try {
        const fusions = processor.advanceBySilence(wallNow)
        if (fusions.length > 0) await this.deps.applyFusions(processor.deviceId, key, fusions)
      } catch (err) {
        this.deps.logger.warn('tracker sweep: silence advance failed for one processor', {
          tags: { deviceId: processor.deviceId },
          meta: { key, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  /** A row may close only when no processor of its camera still holds its chain. */
  canClose(track: SweptTrack, wallNow: number): boolean {
    return this.canCloseReason(track, wallNow) === undefined
  }

  /**
   * Which half of `canClose` is holding the row open, for the force-close /
   * first-hold log (D683 review M2) — `canClose` itself stays a bare boolean
   * for the hot gate path. `undefined` means closable.
   */
  canCloseReason(track: SweptTrack, wallNow: number): 'live' | 'tail-not-final' | undefined {
    for (const p of this.deps.processorsOf(track.deviceId)) {
      if (p.isLive(track.trackId)) return 'live'
      const frameT = p.frameNow(wallNow)
      if (frameT !== null && !p.isTailFinal(track.trackId, frameT)) return 'tail-not-final'
    }
    return undefined
  }
}
