/**
 * `HksvFragmentSource` — the PERMANENT per-camera fMP4 child that keeps a
 * HomeKit Secure Video prebuffer warm.
 *
 * ## Why permanent, and what it costs
 *
 * HKSV's contract is that a clip STARTS BEFORE the trigger. The only way to
 * have bytes from before an event is to have been muxing already, so the
 * prebuffer is not a buffer decision, it is the decision to run an ffmpeg
 * whether or not anything is watching. §A4.2 of the assessment refused to
 * schedule that on an unmeasured guess of ~77 % of a core.
 *
 * Measured (`recording-source.ts` carries the table): **0.7 % of one core and
 * 30 MB RSS** for `-c:v copy` + AAC at 720p, against 89.9 % and 577 MB for a
 * 4K→1080p transcode. That is what makes this affordable, and it is why the
 * source refuses to run on anything but the copy branch.
 *
 * ## What it owns, and what it deliberately does not
 *
 * It owns the child and the plane. It does NOT own the recording policy: it is
 * started and stopped by the delegate, which is the only thing that knows
 * whether iOS has recording switched on. A source that started itself on boot
 * would be a permanent transcode per exposed camera regardless of whether the
 * operator uses HKSV at all.
 *
 * ## Two restarts, both deliberate
 *
 * - **A child that dies while live** is respawned after a backoff, because the
 *   prebuffer is worthless if a night's RTSP blip ends it permanently. Bounded
 *   and announced, never an infinite tight loop (the rule `CrashSupervisor`
 *   enforces for runners, D6).
 * - **`RecordingAudioActive` flipping** respawns onto the muted url. HAP is
 *   explicit: when that characteristic is false the fragments MUST NOT carry
 *   audio, and an fMP4 fragment has no second plane to strip it on.
 */
import type { FfmpegInvocation, IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import type { FfmpegSpawnFn, Fmp4Subscription } from '@camstack/types/node'
import { Fmp4FragmentChild, Fmp4FragmentPlane } from '@camstack/types/node'

import { buildRecordingInvocation } from './recording-invocation.js'
import { HKSV_PREBUFFER_MS } from './recording-options.js'
import type { RecordingSource } from './recording-source.js'

/**
 * How far back the prebuffer ring reaches.
 *
 * Twice {@link HKSV_PREBUFFER_MS}, and the factor is structural rather than
 * generous: the ring holds WHOLE fragments, so a window of exactly 4 s can hold
 * a single 4 s fragment that is about to age out — a trigger landing a moment
 * later would replay nothing. Two fragment lengths guarantee at least one
 * covering fragment at every instant.
 */
export const PREBUFFER_WINDOW_MS = HKSV_PREBUFFER_MS * 2

/**
 * The ring's hard byte ceiling, per camera.
 *
 * Measured fragment sizes on this fleet: ~145 KB for 4 s at 720p, ~3.6 MB for
 * 4 s at 4K. 16 MB covers two 4K fragments with room and bounds the exporter's
 * heap at a figure an operator can multiply by the camera count — which is the
 * number a time-only bound refuses to give.
 */
export const PREBUFFER_MAX_BYTES = 16 * 1024 * 1024

/** Backoff after a child that died while live. Bounded, never a tight loop. */
const RESPAWN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const

/**
 * How a failing respawn is LOGGED — never how long it is retried. The source
 * never gives up: HKSV's only other way back is an iOS state change (toggling
 * recording in the Home app), so a camera outage longer than the backoff would
 * otherwise leave recording dark for days. The first
 * {@link RESPAWN_LOG_FIRST_FAILURES} failures are each logged (the backoff is
 * still climbing); after that, one ERROR every {@link RESPAWN_LOG_EVERY_FAILURES}
 * failures, carrying the count — at the 30 s ceiling that is one line per five
 * minutes per camera: visible, not a flood.
 */
export const RESPAWN_LOG_FIRST_FAILURES = RESPAWN_BACKOFF_MS.length
export const RESPAWN_LOG_EVERY_FAILURES = 10

export interface HksvFragmentSourceInput {
  readonly logger: IScopedLogger
  readonly deviceId: number
  /** The node's pinned ffmpeg (D540). A rejection fails the start, named per
   *  camera — never a PATH lookup. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnFn: FfmpegSpawnFn
  readonly source: RecordingSource
  /** The advertised fragment length — the argv's `-min_frag_duration` basis. */
  readonly fragmentMs: number
  /** Whether iOS currently wants audio in the fragments. */
  readonly audioActive: boolean
  /**
   * The hardware decoder for the ENCODE branch (`-hwaccel`'s value), or `null`.
   * A copy source ignores it — see {@link buildRecordingInvocation}.
   */
  readonly decodeHwAccel?: string | null
  /** The input flags that travel with `-hwaccel` (`-hwaccel_device …`). */
  readonly decodeInputArgs?: readonly string[]
  /** Test seam for the ring's clock; production leaves it unset. */
  readonly now?: () => number
  /** Test seam for the respawn timer. */
  readonly setTimeoutFn?: typeof setTimeout
}

export class HksvFragmentSource {
  private plane: Fmp4FragmentPlane | null = null
  private child: Fmp4FragmentChild | null = null
  private stopped = false
  private starting: Promise<void> | null = null
  private respawnAttempt = 0
  private respawnTimer: NodeJS.Timeout | null = null
  private audioActive: boolean
  private readonly log: IScopedLogger

  constructor(private readonly input: HksvFragmentSourceInput) {
    this.audioActive = input.audioActive
    this.log = input.logger
  }

  /** True once a child has produced its initialisation segment. */
  get isRunning(): boolean {
    return this.child !== null && this.plane !== null && !this.plane.isEnded
  }

  /**
   * Spawn the child and start filling the ring. Idempotent, and concurrent
   * calls share one attempt — `updateRecordingActive(true)` and a stream
   * request can arrive in either order.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('hksv fragment source: already stopped')
    if (this.isRunning) return
    const inflight = this.starting
    if (inflight !== null) return inflight
    const attempt = this.spawn()
    this.starting = attempt
    try {
      await attempt
    } finally {
      this.starting = null
    }
  }

  /** Stop the child, end the plane, forget the ring. Idempotent. */
  async stop(reason: string): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearRespawn()
    this.log.info('hksv fragment source: stopping', {
      tags: { deviceId: this.input.deviceId },
      meta: { reason, brokerId: this.input.source.brokerId },
    })
    const child = this.child
    this.child = null
    if (child) await child.stop()
    this.plane?.dispose()
    this.plane = null
  }

  /**
   * iOS turned recording audio on or off. Respawns onto the other url when it
   * genuinely changed — the fragments themselves must carry or omit the track,
   * there is nothing to strip downstream.
   */
  async setAudioActive(active: boolean): Promise<void> {
    if (active === this.audioActive) return
    this.audioActive = active
    this.log.info('hksv fragment source: RecordingAudioActive changed — respawning the child', {
      tags: { deviceId: this.input.deviceId },
      meta: { audioActive: active, brokerId: this.input.source.brokerId },
    })
    if (!this.isRunning) return
    const child = this.child
    this.child = null
    if (child) await child.stop()
    this.plane?.dispose()
    this.plane = null
    await this.start()
  }

  /**
   * Subscribe to the live fragments, replaying the prebuffer first.
   *
   * Returns `null` when there is no plane — the caller MUST treat that as
   * "cannot serve this recording" rather than opening an HDS stream it cannot
   * feed, which is the D50 failure exactly.
   *
   * Called ONCE PER CONSUMER, never shared: the delegate takes one for HomeKit
   * and the clip tee takes a second. `queueCapacity` is how much slack this
   * subscriber gets before the plane closes it (D80 closes, never gaps) — the
   * tee asks for less than HomeKit's stream on purpose.
   */
  subscribe(tag: string, queueCapacity?: number): Fmp4Subscription | null {
    const plane = this.plane
    if (plane === null || plane.isEnded) return null
    const stats = plane.prebufferStats()
    this.log.info('hksv fragment source: subscribing a recording stream', {
      tags: { deviceId: this.input.deviceId },
      meta: {
        tag,
        prebufferFragments: stats.fragments,
        prebufferBytes: stats.bytes,
        prebufferSpanMs: stats.spanMs,
      },
    })
    return plane.subscribe({
      tag,
      withPrebuffer: true,
      ...(queueCapacity === undefined ? {} : { queueCapacity }),
    })
  }

  /** What the ring holds — surfaced so the delegate can log what it served. */
  prebufferSpanMs(): number {
    return this.plane?.prebufferStats().spanMs ?? 0
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async spawn(): Promise<void> {
    let ffmpegBinaryPath: string
    try {
      ffmpegBinaryPath = await this.input.resolveFfmpeg()
    } catch (err: unknown) {
      this.log.error('hksv fragment source: refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId: this.input.deviceId },
        meta: {
          brokerId: this.input.source.brokerId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw err
    }
    const plane = new Fmp4FragmentPlane(
      this.log.child('hksv-plane'),
      { windowMs: PREBUFFER_WINDOW_MS, maxBytes: PREBUFFER_MAX_BYTES },
      this.input.now ?? Date.now,
    )
    const child = new Fmp4FragmentChild(
      {
        logger: this.log.child('hksv-fmp4'),
        ffmpegBinaryPath,
        spawnFn: this.input.spawnFn,
        onChildExit: (error) => this.onChildExit(error),
      },
      {
        sourceId: `hksv/${this.input.deviceId}`,
        deviceId: this.input.deviceId,
        fragmentMs: this.input.fragmentMs,
        invocation: this.buildInvocation(),
        plane,
      },
    )
    this.plane = plane
    this.child = child
    try {
      await child.start()
      this.respawnAttempt = 0
      this.log.info('hksv fragment source: prebuffer running', {
        tags: { deviceId: this.input.deviceId },
        meta: {
          brokerId: this.input.source.brokerId,
          resolution: `${this.input.source.width}x${this.input.source.height}`,
          branch: this.input.source.transcode ? 'transcode' : 'copy',
          fragmentMs: this.input.fragmentMs,
          audioActive: this.audioActive,
          windowMs: PREBUFFER_WINDOW_MS,
        },
      })
    } catch (err) {
      this.plane = null
      this.child = null
      plane.dispose()
      throw err
    }
  }

  /**
   * The child died while live. The prebuffer is gone with it — and saying so is
   * the point: a source that silently stopped filling reads, from the delegate,
   * exactly like a camera nothing ever happens on.
   */
  private onChildExit(error: Error): void {
    if (this.stopped) return
    this.child = null
    this.plane = null
    this.log.warn(
      'hksv fragment source: the child DIED — the prebuffer is empty until it respawns',
      {
        tags: { deviceId: this.input.deviceId },
        meta: {
          brokerId: this.input.source.brokerId,
          attempt: this.respawnAttempt + 1,
          error: error.message,
        },
      },
    )
    this.scheduleRespawn()
  }

  /**
   * Arm ONE respawn on the backoff. A respawn whose `start()` fails — a
   * resolver rejection (D540), a camera that is rebooting — is RE-armed rather
   * than dropped, forever, at the 30 s ceiling: bounded by RATE (one spawn per
   * camera per 30 s), never by count. Before, one failed respawn left the
   * prebuffer dark until HomeKit happened to call `start()` again.
   */
  private scheduleRespawn(): void {
    if (this.stopped) return
    const delay = RESPAWN_BACKOFF_MS[Math.min(this.respawnAttempt, RESPAWN_BACKOFF_MS.length - 1)]
    this.respawnAttempt += 1
    this.clearRespawn()
    const schedule = this.input.setTimeoutFn ?? setTimeout
    this.respawnTimer = schedule(() => {
      this.respawnTimer = null
      if (this.stopped) return
      void this.start().catch((err: unknown) => {
        this.logRespawnFailure(err)
        this.scheduleRespawn()
      })
    }, delay ?? 30_000)
    this.respawnTimer?.unref?.()
  }

  /** Rate-limited: see {@link RESPAWN_LOG_EVERY_FAILURES}. */
  private logRespawnFailure(err: unknown): void {
    const failures = this.respawnAttempt
    const meta = {
      brokerId: this.input.source.brokerId,
      failures,
      error: err instanceof Error ? err.message : String(err),
    }
    const tags = { deviceId: this.input.deviceId }
    if (failures <= RESPAWN_LOG_FIRST_FAILURES) {
      this.log.warn('hksv fragment source: respawn failed — trying again on the backoff', {
        tags,
        meta,
      })
      return
    }
    if (failures % RESPAWN_LOG_EVERY_FAILURES !== 0) return
    this.log.error(
      'hksv fragment source: still cannot respawn — the prebuffer is empty; retrying every 30 s',
      { tags, meta: { ...meta, suppressedSinceLast: RESPAWN_LOG_EVERY_FAILURES - 1 } },
    )
  }

  private clearRespawn(): void {
    if (this.respawnTimer !== null) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
  }

  /**
   * The invocation, minus the sink the child owns.
   *
   * `kind: 'copy'` is not a preference: it is the 128× measurement, and it is
   * why `pickRecordingSource` refuses a camera whose only slots are H.265. The
   * audio IS encoded — the source mic is G.711/PCM depending on vendor and HKSV
   * takes AAC only — which the same measurement priced at 0.4 % of a core.
   */
  private buildInvocation(): Omit<FfmpegInvocation, 'sink' | 'audioSidecar'> {
    return buildRecordingInvocation({
      source: this.input.source,
      audioActive: this.audioActive,
      fragmentMs: this.input.fragmentMs,
      decodeHwAccel: this.input.decodeHwAccel ?? null,
      ...(this.input.decodeInputArgs === undefined
        ? {}
        : { decodeInputArgs: this.input.decodeInputArgs }),
    })
  }
}
