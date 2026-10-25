/**
 * The broker's way back from "no pinned ffmpeg" (D540).
 *
 * The broker resolves the node's pinned build once, in `onInitialize`. When that
 * fails, which is what happens when every runner on a node starts at once for an
 * `FFMPEG_RELEASE` bump and the download is slow or down, every child
 * refuses by name. Before this, nothing ever asked again: one failed boot-time
 * download disabled every transcode, derived stream, sentry, clip and
 * ffmpeg-parsed camera until the runner restarted.
 *
 * So a refusal ASKS. The first refusal starts ONE shared re-resolve in the
 * background. It is single-flighted, and bounded: at most one attempt per
 * {@link FFMPEG_RERESOLVE_MIN_INTERVAL_MS}, so a burst of refused dials can
 * never turn into a burst of downloads. On success, the path is applied
 * everywhere the broker holds one. The refused dial itself is retried by its
 * caller, as any refusal is. There is no timer: work that wants the binary is
 * what drives the next attempt.
 */
import type { IScopedLogger } from '@camstack/types'
import type { FfmpegHwAccelSetting, FfmpegSystemConfig } from './ffmpeg-invocation.js'

/** At most one re-resolve attempt per this window. */
export const FFMPEG_RERESOLVE_MIN_INTERVAL_MS = 30_000

export interface FfmpegReresolverDeps {
  /** The node's pinned ffmpeg — the same resolver the boot path used. */
  readonly resolve: () => Promise<string>
  /** Hand a resolved path to every holder (config, live brokers, demux). */
  readonly apply: (binaryPath: string) => void
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly minIntervalMs?: number
}

/** Why a re-resolve was, or was not, started. */
export type FfmpegReresolveStart = 'started' | 'in-flight' | 'too-soon'

export class FfmpegReresolver {
  private inFlight: Promise<void> | null = null
  private lastAttemptAt: number | null = null

  constructor(private readonly deps: FfmpegReresolverDeps) {}

  /**
   * Ask again, unless an attempt is running or one started inside the bound.
   * Never throws; the outcome is logged either way.
   */
  request(reason: string): FfmpegReresolveStart {
    if (this.inFlight !== null) return 'in-flight'
    const now = (this.deps.now ?? Date.now)()
    const minIntervalMs = this.deps.minIntervalMs ?? FFMPEG_RERESOLVE_MIN_INTERVAL_MS
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < minIntervalMs) {
      return 'too-soon'
    }
    this.lastAttemptAt = now
    this.deps.logger.warn('stream-broker: re-resolving the pinned ffmpeg after a refusal (D540)', {
      meta: { reason },
    })
    this.inFlight = this.attempt().finally(() => {
      this.inFlight = null
    })
    return 'started'
  }

  /** The attempt in flight, for a caller (or a spec) that wants to wait. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  private async attempt(): Promise<void> {
    try {
      const binaryPath = await this.deps.resolve()
      this.deps.apply(binaryPath)
      this.deps.logger.info('stream-broker: pinned ffmpeg resolved on retry — children may spawn', {
        meta: { binaryPath },
      })
    } catch (err: unknown) {
      this.deps.logger.error(
        'stream-broker: pinned ffmpeg still unavailable — every ffmpeg child keeps refusing',
        { meta: { error: err instanceof Error ? err.message : String(err) } },
      )
    }
  }
}

/** The manager surface the broker's ffmpeg wiring drives. */
export interface BrokerFfmpegHost {
  setFfmpegConfig(cfg: FfmpegSystemConfig): void
  setFfmpegMissingHandler(handler: () => void): void
}

export interface BrokerFfmpegWiringDeps {
  readonly host: BrokerFfmpegHost
  /** The node's pinned ffmpeg (operator override, else `ensureFfmpeg`). */
  readonly resolve: () => Promise<string>
  /** The operator's per-node hw-accel preference, read at each apply. */
  readonly hwAccel: () => FfmpegHwAccelSetting
  /** Told of every binary the host is given (`null` = none) — the addon's
   *  recorded-playback demux mirror. */
  readonly onBinaryPath?: (binaryPath: string | null) => void
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly minIntervalMs?: number
}

export interface BrokerFfmpegWiring {
  /** The boot-time resolution. Never throws: a miss leaves NO binary. */
  load(): Promise<void>
  /** Ask again — what a refused child (or a demux fallback) calls. */
  request(reason: string): FfmpegReresolveStart
  /** The attempt in flight, for a caller (or a spec) that wants to wait. */
  settled(): Promise<void>
}

/**
 * The broker addon's whole ffmpeg wiring, in one place a spec can drive: the
 * boot-time resolution, the refusal handler on the manager, and the
 * re-resolve that hands a later success back to the manager's config — which
 * every live broker reads per dial.
 */
export function wireBrokerFfmpeg(deps: BrokerFfmpegWiringDeps): BrokerFfmpegWiring {
  const give = (binaryPath: string | null): void => {
    deps.host.setFfmpegConfig({ binaryPath, hwAccel: deps.hwAccel(), threadCount: 0 })
    deps.onBinaryPath?.(binaryPath)
  }
  const reresolver = new FfmpegReresolver({
    resolve: deps.resolve,
    apply: give,
    logger: deps.logger,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.minIntervalMs !== undefined ? { minIntervalMs: deps.minIntervalMs } : {}),
  })
  deps.host.setFfmpegMissingHandler(() => {
    reresolver.request('a broker ffmpeg child was refused')
  })
  return {
    load: async () => {
      try {
        const binaryPath = await deps.resolve()
        give(binaryPath)
        deps.logger.info('Loaded ffmpeg config', {
          meta: { binaryPath, hwAccel: deps.hwAccel() },
        })
      } catch (err: unknown) {
        // Not a warning: the broker is left WITHOUT a binary, and every child
        // that needs one refuses by name (per camera). It used to keep a
        // `'ffmpeg'` default here — the HOST's binary, off PATH — so a failed
        // resolution looked like working transcodes (D540). The first refused
        // child starts the bounded re-resolve.
        give(null)
        deps.logger.error(
          'stream-broker: could not resolve the pinned ffmpeg — every ffmpeg child on this node refuses until this is fixed',
          { meta: { error: err instanceof Error ? err.message : String(err) } },
        )
      }
    },
    request: (reason) => reresolver.request(reason),
    settled: () => reresolver.settled(),
  }
}
