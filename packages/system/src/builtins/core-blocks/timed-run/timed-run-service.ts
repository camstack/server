/**
 * The `timed-run` provider of core-blocks (D993): switch a device on, and the
 * hub owes it an off after a chosen time.
 *
 * DURABLE. The deadline is a row per device, written BEFORE the device is
 * switched on, so a crash between the two can only cost a harmless extra off at
 * boot, never a device left running with nobody to stop it.
 *
 * ONE time-ordered timer (D983): only the earliest deadline is armed, and when
 * it fires the next one is armed. Not a timer per device.
 *
 * D49: the off is a one-shot. It is issued once, never gated on a read, and a
 * failed off is logged with the device tag and not retried in a loop; the row is
 * dropped either way so a boot does not re-issue it forever.
 *
 * A manual off (the switch observed off, the pump observed stopped) cancels the
 * pending deadline silently: the operator already did what the timer would do.
 * An explicit `cancel` (Stop) is the opposite: it switches the device off too.
 */
import {
  type IScopedLogger,
  type ITimedRunProvider,
  type TimedRunActuator,
  type TimedRunStatus,
  timedRunLimitOf,
  timedRunMaxIn,
  timedRunQuickRun,
  timedRunSeconds,
} from '@camstack/types'
import type { PowerSourceScheduler, PowerSourceTimer } from '../power-source-service.js'
import type { TimedRunRowBody } from '../record-kinds.js'

/** The stored deadlines, one per device. */
export interface TimedRunRows {
  readonly get: (deviceId: number) => Promise<TimedRunRowBody | null>
  readonly put: (deviceId: number, body: TimedRunRowBody) => Promise<void>
  readonly remove: (deviceId: number) => Promise<void>
  readonly all: () => Promise<
    readonly { readonly deviceId: number; readonly body: TimedRunRowBody }[]
  >
}

export interface TimedRunActuation {
  /** Throws when the device does not take the command. */
  readonly set: (deviceId: number, actuator: TimedRunActuator, on: boolean) => Promise<void>
}

/** The one-tap run duration an operator stored per device, in the type's unit. */
export interface TimedRunQuickRuns {
  readonly read: (deviceId: number) => Promise<number | null>
  readonly write: (deviceId: number, duration: number | null) => Promise<void>
}

/** Which thing a device is: its controls (type) and, among same-control devices, its role. */
export interface DeviceKind {
  readonly type: string
  readonly role: string | null
}

export interface TimedRunServiceDeps {
  readonly rows: TimedRunRows
  /** The device's type and role, or null when it is gone: together they decide the limit (D1033). */
  readonly deviceKindOf: (deviceId: number) => Promise<DeviceKind | null>
  /** Every device whose type offers a timed run: boot publishes each one's status. */
  readonly timedRunDeviceIds: () => Promise<readonly number[]>
  readonly actuation: TimedRunActuation
  readonly quickRuns: TimedRunQuickRuns
  /** Mirror the slice into the device state; failures are logged by the service. */
  readonly publish: (deviceId: number, status: TimedRunStatus) => Promise<void>
  readonly scheduler: PowerSourceScheduler
  readonly now: () => number
  /** Off observations this soon after our own on command are stale echoes, not a manual off. */
  readonly settleMs: number
  readonly logger: IScopedLogger
}

export interface ObservedDeviceState {
  readonly deviceId: number
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
}

const SETTLE_MS_DEFAULT = 3_000
export const TIMED_RUN_SETTLE_MS: number = SETTLE_MS_DEFAULT

export class TimedRunService implements ITimedRunProvider {
  /** Pending deadlines, mirrored from the rows. */
  private readonly pending = new Map<number, TimedRunRowBody>()
  /** When our own on command last resolved, per device. */
  private readonly switchedOnAt = new Map<number, number>()
  private timer: PowerSourceTimer | null = null
  private armedFor: number | null = null
  private inflight: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: TimedRunServiceDeps) {}

  getStatus: ITimedRunProvider['getStatus'] = async ({ deviceId }) => this.statusOf(deviceId)

  getOptions: ITimedRunProvider['getOptions'] = async ({ deviceId }) => {
    const limit = await this.limitOf(deviceId)
    if (limit === null) throw new Error(`timed-run: device ${deviceId} has no timed run`)
    return {
      unit: limit.unit,
      maxDuration: timedRunMaxIn(limit),
      defaultDuration: limit.quickRunDefault,
    }
  }

  /**
   * The one-tap run of a device. Above the type's maximum it is REFUSED, like `runFor`. It
   * THROWS rather than returning a typed result: `setSettings` returns void on every
   * derived-form cap (day-night, image-settings), and the form's save path shows a thrown
   * message to the operator; a void return would let a refused value look saved.
   */
  setSettings: ITimedRunProvider['setSettings'] = async ({ deviceId, settings }) => {
    const limit = await this.limitOf(deviceId)
    if (limit === null) throw new Error(`timed-run: device ${deviceId} has no timed run`)
    const duration = settings.quickRunDuration
    if (duration === undefined) return
    if (duration !== null && duration > timedRunMaxIn(limit)) {
      this.deps.logger.warn('timed-run refused: the one-tap run is over the maximum', {
        tags: { deviceId },
      })
      throw new Error(
        `timed-run: a one-tap run of ${duration} ${limit.unit} is over the maximum of ${timedRunMaxIn(limit)} ${limit.unit}`,
      )
    }
    await this.deps.quickRuns.write(deviceId, duration)
    await this.publishStatus(deviceId)
  }

  private async limitOf(deviceId: number): Promise<ReturnType<typeof timedRunLimitOf>> {
    const kind = await this.deps.deviceKindOf(deviceId)
    return kind === null ? null : timedRunLimitOf(kind.type, kind.role)
  }

  runFor: ITimedRunProvider['runFor'] = async (input) => {
    const { deviceId } = input
    const limit = await this.limitOf(deviceId)
    if (limit === null) {
      this.deps.logger.warn('timed-run refused: device type has no timed run', {
        tags: { deviceId },
      })
      return { ok: false, reason: 'unsupported-device', maxSeconds: null }
    }
    const seconds = timedRunSeconds(input.duration, input.unit)
    if (seconds > limit.maxSeconds) {
      this.deps.logger.warn('timed-run refused: over the maximum', { tags: { deviceId } })
      return { ok: false, reason: 'over-max', maxSeconds: limit.maxSeconds }
    }
    const now = this.deps.now()
    const body: TimedRunRowBody = {
      activeUntil: now + seconds * 1000,
      requestedBy: null,
      requestedAt: now,
      actuator: limit.actuator,
    }
    // Persist first: a crash after this line costs one extra off at boot.
    await this.deps.rows.put(deviceId, body)
    try {
      await this.deps.actuation.set(deviceId, limit.actuator, true)
    } catch (error) {
      await this.deps.rows.remove(deviceId).catch((removeError: unknown) =>
        this.deps.logger.warn('timed-run could not drop the row after a failed on', {
          tags: { deviceId },
          meta: { error: String(removeError) },
        }),
      )
      this.pending.delete(deviceId)
      this.rearm()
      this.deps.logger.warn('timed-run: the device did not turn on', {
        tags: { deviceId },
        meta: { error: String(error) },
      })
      return { ok: false, reason: 'command-failed', maxSeconds: limit.maxSeconds }
    }
    this.switchedOnAt.set(deviceId, this.deps.now())
    this.pending.set(deviceId, body)
    this.rearm()
    await this.publishStatus(deviceId)
    return { ok: true, activeUntil: body.activeUntil }
  }

  /**
   * Stop a run: the device this run switched on is switched OFF, once, and the
   * deadline is forgotten. Nothing armed means nothing to stop - no command is sent.
   * D49: the off is a one-shot; a failure is logged with the device tag, not retried,
   * and the row is dropped either way.
   */
  cancel: ITimedRunProvider['cancel'] = async ({ deviceId }) => {
    const armed = this.pending.get(deviceId)
    if (armed === undefined) {
      await this.forget(deviceId)
      return
    }
    this.deps.logger.info('timed-run: stopped by request, switching the device off', {
      tags: { deviceId },
    })
    try {
      await this.deps.actuation.set(deviceId, armed.actuator, false)
    } catch (error) {
      this.deps.logger.warn('timed-run: the stop did not reach the device; not retrying', {
        tags: { deviceId },
        meta: { error: String(error) },
      })
    }
    await this.forget(deviceId)
  }

  /** Feed one `DeviceStateChanged`: a manual off cancels the pending deadline. */
  async onDeviceState(state: ObservedDeviceState): Promise<void> {
    const row = this.pending.get(state.deviceId)
    if (row === undefined) return
    const off =
      (state.capName === 'switch' && row.actuator === 'switch' && state.slice['on'] === false) ||
      (state.capName === 'pet-fountain' &&
        row.actuator === 'pet-fountain' &&
        state.slice['pumpRunning'] === false)
    if (!off) return
    const at = this.switchedOnAt.get(state.deviceId)
    if (at !== undefined && this.deps.now() - at < this.deps.settleMs) return
    await this.forget(state.deviceId)
  }

  /** Boot: a passed deadline is switched off once, a future one is re-armed. */
  async reconcile(): Promise<void> {
    const rows = await this.deps.rows.all()
    const now = this.deps.now()
    for (const { deviceId, body } of rows) {
      if (body.activeUntil <= now) this.queueExpire(deviceId, body)
      else this.pending.set(deviceId, body)
    }
    this.rearm()
    // Every timed-run device, not only the armed ones: a slice published before quickRun
    // existed has none, and a surface hides the one-tap button until the status carries it.
    const ids = new Set([
      ...rows.map((row) => row.deviceId),
      ...(await this.deps.timedRunDeviceIds()),
    ])
    for (const deviceId of ids) await this.publishStatus(deviceId)
  }

  /** Resolves when every deadline that already fired has been carried out. */
  async settled(): Promise<void> {
    await this.inflight
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
    this.timer = null
    this.armedFor = null
  }

  private async forget(deviceId: number): Promise<void> {
    this.pending.delete(deviceId)
    this.switchedOnAt.delete(deviceId)
    await this.deps.rows.remove(deviceId).catch((error: unknown) =>
      this.deps.logger.warn('timed-run could not drop the row', {
        tags: { deviceId },
        meta: { error: String(error) },
      }),
    )
    this.rearm()
    await this.publishStatus(deviceId)
  }

  private async statusOf(deviceId: number): Promise<TimedRunStatus> {
    const row = this.pending.get(deviceId)
    const limit = await this.limitOf(deviceId)
    return {
      activeUntil: row?.activeUntil ?? null,
      requestedBy: row?.requestedBy ?? null,
      // A removed device or a type without a timed run still answers: no one-tap run to offer.
      quickRun:
        limit === null ? null : timedRunQuickRun(limit, await this.deps.quickRuns.read(deviceId)),
      lastFetchedAt: this.deps.now(),
    }
  }

  private async publishStatus(deviceId: number): Promise<void> {
    try {
      await this.deps.publish(deviceId, await this.statusOf(deviceId))
    } catch (error) {
      this.deps.logger.warn('timed-run could not publish its state', {
        tags: { deviceId },
        meta: { error: String(error) },
      })
    }
  }

  /** Arm the ONE timer for the earliest pending deadline. */
  private rearm(): void {
    if (this.stopped) return
    let next: number | null = null
    for (const row of this.pending.values()) {
      if (next === null || row.activeUntil < next) next = row.activeUntil
    }
    if (next === this.armedFor && (next === null || this.timer !== null)) return
    this.timer?.cancel()
    this.timer = null
    this.armedFor = next
    if (next === null) return
    const delay = Math.max(0, next - this.deps.now())
    this.timer = this.deps.scheduler.schedule(delay, () => this.onTimer())
  }

  private onTimer(): void {
    this.timer = null
    this.armedFor = null
    const now = this.deps.now()
    for (const [deviceId, body] of [...this.pending.entries()]) {
      if (body.activeUntil <= now) this.queueExpire(deviceId, body)
    }
    this.rearm()
  }

  private queueExpire(deviceId: number, body: TimedRunRowBody): void {
    this.pending.delete(deviceId)
    this.inflight = this.inflight.then(() => this.expire(deviceId, body))
  }

  /** The one-shot off. Logged on failure, never retried (D49). */
  private async expire(deviceId: number, body: TimedRunRowBody): Promise<void> {
    try {
      await this.deps.actuation.set(deviceId, body.actuator, false)
    } catch (error) {
      this.deps.logger.warn('timed-run: the off did not reach the device; not retrying', {
        tags: { deviceId },
        meta: { error: String(error) },
      })
    }
    this.switchedOnAt.delete(deviceId)
    await this.deps.rows.remove(deviceId).catch((error: unknown) =>
      this.deps.logger.warn('timed-run could not drop the row after its off', {
        tags: { deviceId },
        meta: { error: String(error) },
      }),
    )
    await this.publishStatus(deviceId)
  }
}
