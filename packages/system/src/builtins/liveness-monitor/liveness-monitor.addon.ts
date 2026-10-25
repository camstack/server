/**
 * liveness-monitor — the node states, out loud, when it has stopped working.
 *
 * On 2026-08-03 the hub ran for four hours with zero devices, zero published
 * streams and zero recordings. Three separate defects caused it, each silent at
 * the point of failure, and the operator found out by opening the viewer. Every
 * one of those defects has since been fixed and given a log line — but a log
 * line per known bug does not cover the next one. This addon covers the class:
 * it asserts what must be true of a working node and reports when it is not.
 *
 * It emits `SystemLivenessFailed` / `SystemLivenessRecovered` on the event bus
 * with a STABLE finding id, exactly like the kernel's addon-health monitor, so
 * AlertCenter raises one persistent alert per fault and dismisses it on
 * recovery instead of producing a stream of them. The same lines go to the log
 * at ERROR, which is what makes them alertable in Loki.
 *
 * Deliberately hub-only and deliberately read-only: it observes through
 * `ctx.api` and changes nothing. A monitor that can act is a monitor that can
 * cause the outage it was meant to report — this repo has already stopped a
 * hub that way once (the remedial-action watcher, 2026-07-30).
 */
import * as fsp from 'node:fs/promises'
import {
  BaseAddon,
  errMsg,
  type ProviderRegistration,
  RECORDING_SOURCE_CAMSTACK_ADDON,
  RecordingStatusSchema,
} from '@camstack/types'
import {
  type CameraFootage,
  evaluateLiveness,
  isLivenessFindingId,
  type LivenessFinding,
} from './liveness-checks.js'
import { LivenessReporter } from './liveness-reporter.js'
import {
  isStorageRootFindingId,
  nodeStorageRootProbe,
  probeStorageRoot,
  storageRootFindings,
  storageRootTargets,
} from './storage-root-access.js'

/** The node this monitor runs on (it is hub-only). */
const HUB_NODE_ID = 'hub'

/** How often the invariants are checked. */
const TICK_INTERVAL_MS = 5 * 60_000

/**
 * Grace period after boot before anything is reported.
 *
 * Every check would be true during startup — devices restore, providers
 * connect, the first segment takes a minute — and a monitor that cries at every
 * restart is one nobody reads. The kernel's addon-health monitor takes the same
 * position for the same reason.
 */
const BOOT_GRACE_MS = 6 * 60_000

/** How long a recording camera may stay silent before it is a fault. */
const DEFAULT_STALE_AFTER_MS = 15 * 60_000

/**
 * How far back to look for "does this camera record at all". A camera with no
 * footage in this window is treated as a non-recording camera and never
 * reported — which is what keeps the check free of any configuration coupling.
 */
const RECORDING_LOOKBACK_MS = 24 * 60 * 60_000

interface LivenessMonitorConfig extends Record<string, unknown> {
  readonly staleAfterMs?: number
}

export class LivenessMonitorAddon extends BaseAddon<LivenessMonitorConfig> {
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private startedAtMs = 0
  private reporter: LivenessReporter | null = null
  /** Roots whose writability could not be read, already said once. */
  private readonly unknownRootsSaid = new Set<string>()

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.startedAtMs = Date.now()
    this.reporter = new LivenessReporter({
      logger: this.ctx.logger,
      emit: (event) => this.ctx.eventBus.emit(event),
    })
    // A storage root this process cannot write is known the moment the node
    // starts: it is checked NOW, outside the boot grace, and on every tick.
    void this.checkStorageRoots()
    this.tickTimer = setInterval(() => {
      void this.tick()
    }, TICK_INTERVAL_MS)
    // Node timers keep the process alive; a monitor must never be the reason a
    // node refuses to exit.
    this.tickTimer.unref?.()
    this.ctx.logger.info('liveness-monitor started', {
      meta: { tickIntervalMs: TICK_INTERVAL_MS, bootGraceMs: BOOT_GRACE_MS },
    })
    return []
  }

  protected async onShutdown(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  /**
   * One evaluation. Public so a test or an operator-facing action can force it
   * without waiting out the interval.
   */
  async tick(): Promise<readonly LivenessFinding[]> {
    const storage = await this.checkStorageRoots()
    if (Date.now() - this.startedAtMs < BOOT_GRACE_MS) return storage
    try {
      const facts = await this.gather()
      const findings = evaluateLiveness(facts)
      this.reporter?.report(findings, isLivenessFindingId)
      return [...storage, ...findings]
    } catch (err) {
      // The monitor must never take the node down, and it must never fail
      // quietly either — a silent monitor is indistinguishable from a healthy
      // node, which is the exact confusion it exists to remove.
      this.ctx.logger.error('liveness-monitor: check failed — node health is UNKNOWN this tick', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  /** Read the facts through the cap surface. Changes nothing. */
  private async gather(): Promise<{
    nowMs: number
    deviceCount: number
    cameras: readonly CameraFootage[]
    staleAfterMs: number
  }> {
    const nowMs = Date.now()
    const staleAfterMs = this.config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    const devices = await this.ctx.api.deviceManager.listAll.query({})

    // No devices: every other question is a consequence, and asking them would
    // cost twelve calls to learn nothing.
    if (devices.length === 0) return { nowMs, deviceCount: 0, cameras: [], staleAfterMs }

    const cameraDevices = devices.filter((d) => d.isCamera === true)
    const cameras: CameraFootage[] = []
    for (const device of cameraDevices) {
      const lastSegmentMs = await this.lastSegmentMs(device.id, nowMs, staleAfterMs)
      // The mode is asked only of a camera that LOOKS silent — the one call
      // that decides whether silence means anything — so a healthy tick stays
      // at one availability read per camera.
      const silent = lastSegmentMs !== null && nowMs - lastSegmentMs > staleAfterMs
      const activeMode = silent
        ? RecordingStatusSchema.parse(
            await this.ctx.api.recordingArchive.getStatus.query({ deviceId: device.id }),
          ).activeMode
        : null
      cameras.push({
        deviceId: device.id,
        name: device.name,
        online: device.online === true,
        lastSegmentMs,
        activeMode,
      })
    }
    return { nowMs, deviceCount: devices.length, cameras, staleAfterMs }
  }

  /**
   * Newest segment for a camera, or null when it has produced none in a day.
   *
   * Two steps on purpose: the healthy case asks only for the recent window,
   * which is a handful of ranges, and only a camera that looks silent pays for
   * the 24-hour lookback that decides whether it records at all.
   */
  private async lastSegmentMs(
    deviceId: number,
    nowMs: number,
    staleAfterMs: number,
  ): Promise<number | null> {
    // OURS, by name. A kernel builtin must not gain a dependency on the
    // viewer's per-camera source picker: this check is about whether OUR
    // recorder is writing, and a camera's own SD card is not an answer to it
    // (D625).
    const recent = await this.ctx.api.recording.getAvailability.query({
      deviceId,
      provider: RECORDING_SOURCE_CAMSTACK_ADDON,
      fromMs: nowMs - staleAfterMs,
      toMs: nowMs,
    })
    if (recent.read === 'unreadable') return this.unreadable(deviceId, 'recent window')
    if (recent.ranges.length > 0) {
      return Math.max(...recent.ranges.map((r) => r.endMs))
    }
    const day = await this.ctx.api.recording.getAvailability.query({
      deviceId,
      provider: RECORDING_SOURCE_CAMSTACK_ADDON,
      fromMs: nowMs - RECORDING_LOOKBACK_MS,
      toMs: nowMs,
    })
    if (day.read === 'unreadable') return this.unreadable(deviceId, '24 h lookback')
    if (day.ranges.length === 0) return null
    return Math.max(...day.ranges.map((r) => r.endMs))
  }

  /**
   * A camera nobody could read is NOT a camera with no footage.
   *
   * `null` here means "no claim", and `liveness-checks.ts` skips a camera with
   * no claim — which is the safe direction. But a skip that says nothing is
   * indistinguishable from a healthy tick, so the branch that drops the camera
   * names it, per camera (D393, and CLAUDE.md's logging rule).
   */
  private unreadable(deviceId: number, window: string): null {
    this.ctx.logger.warn(
      `liveness: recording availability was unreadable (${window}) — this camera is not judged this tick`,
      { tags: { deviceId } },
    )
    return null
  }

  /**
   * Every storage root this node writes to must be writable BY THIS PROCESS.
   * Reported through the same finding path (one ERROR, one alert, a recovery
   * when it is fixed). Never throws: an unreadable list is said and skipped.
   */
  async checkStorageRoots(): Promise<readonly LivenessFinding[]> {
    const reporter = this.reporter
    if (reporter === null) return []
    try {
      const locations = await this.ctx.api.storage.listLocations.query({})
      const probe = nodeStorageRootProbe(fsp)
      const results = await Promise.all(
        storageRootTargets(locations, HUB_NODE_ID).map((t) => probeStorageRoot(t, probe)),
      )
      for (const result of results) {
        if (result.kind !== 'unknown' || this.unknownRootsSaid.has(result.target.path)) continue
        this.unknownRootsSaid.add(result.target.path)
        this.ctx.logger.warn('liveness: storage root writability could not be read — not judged', {
          meta: {
            path: result.target.path,
            locationIds: result.target.locationIds,
            reason: result.reason,
          },
        })
      }
      const findings = storageRootFindings(results, probe)
      reporter.report(findings, isStorageRootFindingId)
      return findings
    } catch (err: unknown) {
      this.ctx.logger.warn('liveness: storage locations unreadable — storage roots not checked', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }
}
