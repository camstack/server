/**
 * `autotrack` — the EMULATED implementation behind the `ptz-autotrack` switch.
 *
 * A camera with firmware autotrack serves `ptz-autotrack` from its own native
 * provider. A camera with a mechanical head and no firmware autotrack gets the
 * same cap from THIS addon, as a wrapper the operator binds per camera —
 * exactly how `snapshot` gives a frame to a device whose driver cannot take
 * one.
 *
 * That is the whole point of the shape (D62, D520): **one switch**. The
 * operator turns autotrack on in the same place whichever implementation is
 * behind it, and the two can never disagree, because there are not two of them
 * on one camera — the binding chooses which one answers.
 *
 * ## What the emulation may do, and what it may never do (D520)
 *
 * It moves a head ONLY with a self-terminating `ptz.move` pulse — never
 * `continuousMove`, whose `stop` would ride on telemetry that may be dropped,
 * and whose worst case is a camera spinning unattended. It refuses to move at
 * all when it cannot read `moveImpulseMs`, because that number is the proof the
 * head stops without a second message. It refuses while the camera's NATIVE
 * autotrack is on. It is declaredly visual: `getPosition` is null on every PTZ
 * driver here, so the loop never knows where the head points.
 *
 * ## Erring direction: CLOSED
 *
 * A gate whose worst error is a spurious event may err OPEN on an unreadable
 * binding (D49). Here it is the opposite: the cost of running when the
 * operator has unbound us is a head that keeps moving on its own. A camera whose binding cannot be
 * confirmed stops. It resumes the moment a read confirms it again, and the
 * stop is logged — a loop that quietly stopped is the same as a loop that
 * never ran.
 *
 * Its own runner, `hub-only`, and no `execution.group`: it drives devices and a
 * co-located crash would respawn everything sharing the runner (D29).
 */
import type { AddonInitResult, PtzAutotrackSettings, PtzAutotrackStatus } from '@camstack/types'
import {
  BaseAddon,
  EventCategory,
  bareAddonId,
  errMsg,
  isEvent,
  ptzAutotrackCapability,
  type IPtzAutotrackProvider,
} from '@camstack/types'
import { DEFAULT_AUTOTRACK_LOOP_CONFIG } from './autotrack-config.js'
import {
  DEFAULT_CAMERA_RECORD,
  loopConfigFor,
  zoomRefusalFor,
  parseCameraRecords,
  statusFor,
  targetClassFor,
  withCameraPatch,
  type AutotrackCameraRecord,
  type AutotrackCameraRecords,
} from './autotrack-cameras.js'
import type { NativeAutotrackState } from './autotrack-decision.js'
import { AutotrackLoop, type PulseCommand } from './autotrack-loop.js'

/** Persisted shape: one entry per camera the operator has touched. */
export interface AutotrackConfig {
  readonly cameras: Record<string, unknown>
}

/** How often the silence watchdog runs. Small relative to the disappear delay
 *  it enforces — the delay is the budget, this is only the resolution. */
const WATCHDOG_INTERVAL_MS = 5_000

/** One running camera: the loop, and when its switch last changed. */
interface AutotrackSession {
  readonly loop: AutotrackLoop
  readonly deviceId: number
}

export class AutotrackAddon extends BaseAddon<AutotrackConfig> {
  private records: AutotrackCameraRecords = {}
  private readonly sessions = new Map<number, AutotrackSession>()
  /** Cameras whose `ptz-autotrack` binding names THIS addon, last time we read. */
  private bound = new Set<number>()
  /**
   * Cameras that ALSO have a `ptz-autotrack` provider that is not us.
   *
   * This is the only way to ask about a firmware autotrack without asking
   * ourselves: on a camera where our wrapper is the binding, `ptzAutotrack.
   * getStatus` resolves to THIS addon and returns our own switch — so a loop
   * that read it would see `enabled: true` the moment the operator turned it
   * on, conclude the firmware was driving the head, and refuse to move. A
   * self-deadlock that would have looked exactly like the safety gate working.
   */
  private foreignProvider = new Set<number>()
  private readonly lastChangedAt = new Map<number, number>()
  private unsubscribeFrames: (() => void) | null = null
  private unsubscribeBindings: (() => void) | null = null
  private mirrorTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super({ cameras: {} })
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    this.records = parseCameraRecords(this.config.cameras)

    this.unsubscribeFrames = this.ctx.eventBus.subscribe(
      { category: EventCategory.PipelineAnalyticsFrameTracked },
      (event) => {
        if (!isEvent(event, EventCategory.PipelineAnalyticsFrameTracked)) return
        const session = this.sessions.get(event.data.deviceId)
        if (session === undefined) return
        void session.loop
          .onFrame({
            deviceId: event.data.deviceId,
            timestamp: event.data.timestamp,
            frameWidth: event.data.frameWidth,
            frameHeight: event.data.frameHeight,
            detections: event.data.detections,
          })
          .catch((err: unknown) => {
            this.ctx.logger.warn('autotrack frame handling failed', {
              tags: { deviceId: event.data.deviceId },
              meta: { error: errMsg(err) },
            })
          })
      },
    )

    // A binding change is the operator choosing (or un-choosing) this
    // implementation for a camera. Re-read rather than trust the payload: the
    // event says something changed, the read says what is true now.
    this.unsubscribeBindings = this.ctx.eventBus.subscribe(
      { category: EventCategory.DeviceBindingsChanged },
      () => {
        void this.refreshBindings().catch(() => undefined)
      },
    )

    // Both timers run OFF the event path (D49): the frame handler only reads
    // the state they maintain and never awaits a read of its own.
    this.mirrorTimer = setInterval(() => {
      void this.refreshEverything()
    }, DEFAULT_AUTOTRACK_LOOP_CONFIG.mirrorRefreshMs)
    this.watchdogTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        void session.loop.tick().catch((err: unknown) => {
          this.ctx.logger.warn('autotrack watchdog failed', {
            tags: { deviceId: session.deviceId },
            meta: { error: errMsg(err) },
          })
        })
      }
    }, WATCHDOG_INTERVAL_MS)

    await this.refreshEverything()

    const provider: IPtzAutotrackProvider = {
      getStatus: async ({ deviceId }) => this.statusOf(deviceId),
      setEnabled: async ({ deviceId, enabled }) => {
        await this.patchCamera(deviceId, { enabled })
      },
      getSettings: async ({ deviceId }) => this.recordOf(deviceId).settings,
      setSettings: async ({ deviceId, settings }) => {
        await this.patchCamera(deviceId, { settings })
      },
    }

    this.ctx.logger.info('autotrack ready', {
      meta: {
        cameras: Object.keys(this.records).length,
        running: this.sessions.size,
      },
    })

    return { providers: [{ capability: ptzAutotrackCapability, provider }] }
  }

  protected async onShutdown(): Promise<void> {
    if (this.mirrorTimer !== null) clearInterval(this.mirrorTimer)
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.mirrorTimer = null
    this.watchdogTimer = null
    this.unsubscribeFrames?.()
    this.unsubscribeBindings?.()
    this.unsubscribeFrames = null
    this.unsubscribeBindings = null
    // A run that ends before the next scheduled summary still reports what it
    // measured — otherwise a short session produces no measurement at all.
    for (const session of this.sessions.values()) session.loop.logSummary()
    this.sessions.clear()
  }

  protected async onConfigChanged(): Promise<void> {
    this.records = parseCameraRecords(this.config.cameras)
    await this.reconcileSessions()
  }

  private recordOf(deviceId: number): AutotrackCameraRecord {
    return this.records[deviceId] ?? DEFAULT_CAMERA_RECORD
  }

  private statusOf(deviceId: number): PtzAutotrackStatus {
    return statusFor(this.recordOf(deviceId), this.lastChangedAt.get(deviceId) ?? 0)
  }

  private async patchCamera(
    deviceId: number,
    patch: { enabled?: boolean; settings?: Partial<PtzAutotrackSettings> },
  ): Promise<void> {
    const before = this.recordOf(deviceId).enabled
    this.records = withCameraPatch(this.records, deviceId, patch)
    const after = this.recordOf(deviceId).enabled
    if (before !== after) this.lastChangedAt.set(deviceId, Date.now())
    // The addon's own settings are the record for the emulation — the cap's
    // slice is `durability: 'session'` and mirrors a CAMERA, which this
    // implementation does not have (`autotrack-cameras.ts`).
    await this.updateGlobalSettings({ cameras: this.serialiseRecords() })
    // Bindings FIRST, and this ordering is not decoration. `refreshBindings`
    // only asks about cameras it has a record for, so the camera being switched
    // on right now was not in the last answer: reconciling on the stale set
    // starts nothing, and the loop appears dead until the periodic refresh
    // catches up a minute later. Measured the first time the switch was
    // flipped on the hub (2026-09-18).
    await this.refreshEverything()
    // No event is emitted here, deliberately. `ptz-autotrack` DECLARES
    // `onStatusChanged`, but no `EventCategory` exists for it and no provider
    // in this repo emits it — cap events are bridged from runtime-state slices,
    // one category per cap, and this cap never got one. Adding it means a
    // framework change plus an emitter on every native provider, and until
    // those exist an event that fires only from the wrapper would be worse than
    // none: a subscriber would read "nothing changed" for every camera whose
    // autotrack is the firmware's (D520). The UI reads `getStatus`.
  }

  private serialiseRecords(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [deviceId, record] of Object.entries(this.records)) {
      out[deviceId] = { enabled: record.enabled, settings: record.settings }
    }
    return out
  }

  /** Bindings first, then sessions: a session must never outlive its binding. */
  private async refreshEverything(): Promise<void> {
    await this.refreshBindings()
    await this.reconcileSessions()
    for (const session of this.sessions.values()) {
      await this.refreshMirror(session)
    }
  }

  /**
   * Which cameras have this addon bound as their `ptz-autotrack` provider.
   *
   * Only cameras the operator has a record for are asked about: a wrapper that
   * enumerated every camera on every refresh would walk the whole fleet to
   * learn nothing about the ones nobody switched on.
   *
   * A read that FAILS leaves the previous answer standing (D49) — a transient
   * store blip must not stop a running loop. A read that SUCCEEDS and omits us
   * is believed immediately: unlike a doorbell press, the cost of erring open
   * here is a head that keeps moving after the operator unbound it.
   */
  private async refreshBindings(): Promise<void> {
    const next = new Set<number>()
    const foreign = new Set(this.foreignProvider)
    const me = bareAddonId(this.ctx.id)
    for (const key of Object.keys(this.records)) {
      const deviceId = Number(key)
      if (!Number.isInteger(deviceId)) continue
      try {
        const { entries } = await this.ctx.api.deviceManager.getBindings.query({ deviceId })
        const autotrackEntries = entries.filter(
          (entry) => entry.capName === ptzAutotrackCapability.name,
        )
        if (autotrackEntries.some((entry) => bareAddonId(entry.providerAddonId) === me)) {
          next.add(deviceId)
        }
        if (autotrackEntries.some((entry) => bareAddonId(entry.providerAddonId) !== me)) {
          foreign.add(deviceId)
        } else {
          foreign.delete(deviceId)
        }
      } catch (err) {
        // Keep whatever we knew about THIS camera; a failed read is not an
        // unbind (D49).
        if (this.bound.has(deviceId)) next.add(deviceId)
        this.ctx.logger.debug('autotrack: could not read bindings', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.bound = next
    this.foreignProvider = foreign
  }

  /** Start a loop for every camera that is bound AND switched on; stop the rest. */
  private async reconcileSessions(): Promise<void> {
    for (const [key, record] of Object.entries(this.records)) {
      const deviceId = Number(key)
      const shouldRun = record.enabled && this.bound.has(deviceId)
      const running = this.sessions.get(deviceId)
      if (shouldRun && running === undefined) {
        this.startSession(deviceId, record)
        continue
      }
      if (!shouldRun && running !== undefined) {
        this.stopSession(deviceId, record.enabled ? 'unbound' : 'switched-off')
      }
    }
    // A camera whose record disappeared entirely (settings wiped) still has to
    // stop: iterate the SESSIONS too, not only the records. Deleting the CURRENT
    // key during a Map iteration is defined behaviour — only entries not yet
    // visited can be skipped, and this deletes the one it is standing on.
    for (const deviceId of this.sessions.keys()) {
      if (this.records[deviceId] === undefined) this.stopSession(deviceId, 'record-gone')
    }
  }

  private startSession(deviceId: number, record: AutotrackCameraRecord): void {
    const config = loopConfigFor(record.settings)
    const targetClass = targetClassFor(record.settings)
    const loop = new AutotrackLoop({
      deviceId,
      targetClass,
      // Bound, switched on, and past every refusal the loop itself applies:
      // a missing `moveImpulseMs` and a live native autotrack both still stop
      // it from issuing a command (D520).
      armed: true,
      config,
      logger: this.ctx.logger,
      commands: {
        pulse: (command: PulseCommand) =>
          this.ctx.api.ptz.move.mutate({
            deviceId: command.deviceId,
            pan: command.pan,
            tilt: command.tilt,
            speed: command.speed,
          }),
        goHome: (target: number) => this.ctx.api.ptz.goHome.mutate({ deviceId: target }),
      },
      now: () => Date.now(),
    })
    this.sessions.set(deviceId, { loop, deviceId })
    void this.refreshMirror({ loop, deviceId })
    this.ctx.logger.info('autotrack following', {
      tags: { deviceId },
      meta: {
        targetClass,
        deadZoneFraction: config.deadZoneFraction,
        settleZoneFraction: config.settleZoneFraction,
        maxCommandsPerSecond: config.maxCommandsPerSecond,
        disappearDelayMs: config.disappearDelayMs,
      },
    })
    // `ptz` declares no events, so nothing tells this loop that a person is
    // driving the head from the UI, the vendor app or an NVR (D520). Switching
    // it on is a promise that nobody else is. Said once, loudly.
    this.ctx.logger.warn('autotrack ON: this camera must not be driven by anyone else', {
      tags: { deviceId },
    })
    // A zoom target this loop cannot honour is REPORTED, not ignored. The
    // setting is hidden and defaults to absent, so this line only ever appears
    // on a camera where somebody deliberately set one.
    const zoomRefusal = zoomRefusalFor(record)
    if (zoomRefusal !== null) {
      this.ctx.logger.warn(zoomRefusal, {
        tags: { deviceId },
        meta: { targetSubjectFraction: record.zoom.targetSubjectFraction },
      })
    }
  }

  private stopSession(deviceId: number, reason: string): void {
    const session = this.sessions.get(deviceId)
    if (session === undefined) return
    session.loop.logSummary()
    this.sessions.delete(deviceId)
    // A loop that quietly stopped is indistinguishable from one that never
    // ran, and this one was moving a head.
    this.ctx.logger.info('autotrack stopped following', {
      tags: { deviceId },
      meta: { reason },
    })
  }

  /**
   * One off-event-path refresh of a camera's mirror.
   *
   * Two reads, and either one failing fails the whole refresh: a mirror half
   * from now and half from twenty minutes ago is worse than one that says it
   * is stale. The previous answers stand (D49).
   */
  private async refreshMirror(session: AutotrackSession): Promise<void> {
    try {
      const options = await this.ctx.api.ptz.getOptions.query({ deviceId: session.deviceId })
      const nativeAutotrack = await this.readNativeAutotrack(session.deviceId)
      session.loop.applyMirror({
        kind: 'read',
        moveImpulseMs: options.moveImpulseMs,
        nativeAutotrack,
      })
    } catch (err) {
      session.loop.applyMirror({ kind: 'failed', error: errMsg(err) })
      this.ctx.logger.warn('autotrack mirror refresh failed — the loop holds its last answers', {
        tags: { deviceId: session.deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Is the camera's OWN autotrack on?
   *
   * `null` when the camera has no native autotrack at all — which is the case
   * this addon exists for, and is NOT an error. A camera that HAS one and has
   * it armed makes this loop refuse: two implementations driving one head is
   * the thing the single-switch rule exists to prevent (D62).
   */
  private async readNativeAutotrack(deviceId: number): Promise<NativeAutotrackState> {
    // Nobody but us provides this cap here: there is no firmware autotrack to
    // conflict with, and asking would only ask ourselves.
    if (!this.foreignProvider.has(deviceId)) return 'absent'
    try {
      const status = await this.ctx.api.ptzAutotrack.getStatus.query({ deviceId })
      return status.enabled ? 'enabled' : 'disabled'
    } catch {
      // A camera that HAS a firmware autotrack and would not say whether it is
      // on. `unknown`, never `disabled`: the gate exists to stop two things
      // driving one head, and an unreadable answer is not permission.
      return 'unknown'
    }
  }
}
