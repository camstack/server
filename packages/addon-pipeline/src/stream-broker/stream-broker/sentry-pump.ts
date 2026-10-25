/**
 * The sentry pump: ONE encode, then a 1 fps re-emit until real media lands.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 * A lazy source is BUILT on demand, and on this hub that build costs 2.2 to
 * 12.4 s. For all of it the consumer had black — and Amazon allows SIX SECONDS
 * for an Alexa SDP answer, so a cold battery camera could not answer an Echo at
 * all. The pump makes the broker servable before the camera is: the camera's
 * own last picture under a "Waking" treatment, at the camera's real geometry,
 * replaced by real media the instant the first real packet arrives.
 *
 * ── The three rules it exists to hold ─────────────────────────────────────
 *  1. **Prepare ONCE.** The picture is fetched and encoded a single time per
 *     wake and the bytes are cached here. Re-fetching per tick would put a
 *     snapshot round-trip and a fork+exec on every second of every waking
 *     camera, and would move frames across a process boundary at frame-rate —
 *     D9/D18.
 *  2. **A late preparation lands nowhere.** The encode is async. If the camera
 *     woke while it was running the pump has already been stopped, and starting
 *     the timer then would paint a still picture over live media.
 *  3. **It never dials.** The pump has no source, no socket and no demand. It
 *     is started alongside the publisher request, never instead of it.
 *
 * Emission is the caller's: {@link SentryPumpOptions.emit} is where the
 * `isPlaceholder: true` packet is built, because that flag belongs to the
 * broker's packet contract and the containment that reads it lives there.
 */
import { errMsg, type IScopedLogger, type LogTags } from '@camstack/types'

/** The cached, ready-to-emit synthetic access unit. */
export interface SentryFrame {
  /** A complete Annex-B IDR with inline parameter sets. */
  readonly annexB: Buffer
  readonly codec: 'h264' | 'h265'
}

export interface PreparePrestreamInput {
  /** The lazy source url, as published — what `planPrestream` gates on. */
  readonly sourceUrl: string
}

/**
 * Build the frame, or refuse.
 *
 * `null` is a REFUSAL that the provider has already named and logged (no cached
 * picture, unknown geometry, unknown codec). The pump does not second-guess it
 * and does not retry: refusing is cheap, and the alternative — a sentry at
 * the wrong geometry — is the decoder freeze this whole path is shaped around.
 */
export type PreparePrestream = (input: PreparePrestreamInput) => Promise<SentryFrame | null>

/**
 * What the broker is handed. A single method, so the broker knows nothing about
 * snapshots, device names, geometry or ffmpeg — the manager owns all four and
 * closes over them.
 */
export interface SentryProvider {
  readonly prepare: PreparePrestream
  /**
   * Fired ONCE per wake, on the first real packet — the instant the camera is
   * demonstrably awake and its media is flowing.
   *
   * It exists so the picture this window shows next time is a scene from the
   * LAST EVENT, not one several wakes old. Nothing was refreshing it: a
   * battery camera refuses a capture while it believes itself asleep, and that
   * belief lags the wake by seconds — so the only captures ever attempted were
   * the ones the sentry itself triggered while composing, which is before
   * any media exists. Measured on device 106, 2026-09-16: four wakes across
   * forty minutes, `bytes=23912` every time. The same picture.
   *
   * Optional: a broker with no provider for it behaves exactly as before.
   */
  readonly onRealMediaStarted?: () => void
}

export interface SentryPumpOptions {
  readonly prepare: PreparePrestream
  readonly emit: (frame: SentryFrame) => void
  readonly logger?: IScopedLogger
  /** Numeric device id. Every line this pump logs carries it. */
  readonly deviceId?: number
  /** Re-emit cadence. 1 fps — a still picture needs no more. */
  readonly intervalMs?: number
}

const DEFAULT_SENTRY_INTERVAL_MS = 1_000

export class SentryPump {
  private readonly options: SentryPumpOptions
  private readonly intervalMs: number
  private readonly tags: { readonly tags: LogTags } | Record<string, never>

  private timer: ReturnType<typeof setInterval> | undefined
  /** True from `start()` until `stop()`, INCLUDING while the encode runs. */
  private active = false
  private frame: SentryFrame | null = null
  private startedAt = 0
  private emitted = 0

  constructor(options: SentryPumpOptions) {
    this.options = options
    this.intervalMs = options.intervalMs ?? DEFAULT_SENTRY_INTERVAL_MS
    this.tags = options.deviceId === undefined ? {} : { tags: { deviceId: options.deviceId } }
  }

  /** Whether the window is currently being filled (or about to be). */
  get running(): boolean {
    return this.active
  }

  /**
   * Open the window. Idempotent: a second call while the first preparation is
   * still in flight is a no-op, so a reconnect tick that re-enters the lazy
   * branch every second does not spawn an encode every second.
   */
  start(sourceUrl: string): void {
    if (this.active) return
    this.active = true
    this.startedAt = Date.now()
    this.emitted = 0

    this.options
      .prepare({ sourceUrl })
      .then((frame) => {
        if (!this.active) {
          // Rule 2: the camera woke while we were encoding.
          this.options.logger?.debug('sentry: preparation landed after the window closed', {
            ...this.tags,
          })
          return
        }
        if (frame === null) {
          // The provider named the refusal. Say that the window is going
          // unfilled, because a branch that produces nothing must be visible.
          this.options.logger?.info('sentry: refused — the window goes unfilled', {
            ...this.tags,
          })
          this.active = false
          return
        }
        this.frame = frame
        this.options.logger?.info('sentry: filling the wake window', {
          ...this.tags,
          meta: {
            codec: frame.codec,
            bytes: frame.annexB.length,
            intervalMs: this.intervalMs,
            preparedInMs: Date.now() - this.startedAt,
          },
        })
        this.tick()
        this.timer = setInterval(() => this.tick(), this.intervalMs)
      })
      .catch((err: unknown) => {
        // A preparation that throws is a branch that accepted work and produced
        // nothing. It is reported, never swallowed.
        this.options.logger?.warn('sentry: preparation failed — the window goes unfilled', {
          ...this.tags,
          meta: { error: errMsg(err) },
        })
        this.active = false
      })
  }

  /**
   * Close the window. Called on the first NON-placeholder packet — the one edge
   * the sentry is defined by — and on the broker's own teardown paths so a
   * stopped broker leaves no timer behind.
   */
  stop(reason: string): void {
    if (!this.active) return
    this.active = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.options.logger?.info('sentry: window closed', {
      ...this.tags,
      meta: { reason, framesEmitted: this.emitted, heldMs: Date.now() - this.startedAt },
    })
    this.frame = null
  }

  private tick(): void {
    const frame = this.frame
    if (!this.active || frame === null) return
    this.emitted++
    this.options.emit(frame)
  }
}
