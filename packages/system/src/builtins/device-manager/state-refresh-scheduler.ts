/**
 * The state-refresh scheduler (D1062, amending D224): the core decides WHEN a
 * migrated provider re-reads a device; the provider only knows HOW.
 *
 * The policy each provider declared on its `device-state-refresh`
 * registration (`StateRefreshPolicyRegistry`) drives it. Devices are grouped
 * per integration instance (`addonId::integrationId`):
 *
 * - cadence: `effectiveRefreshIntervalMs` — the declared minimum, slowed (never
 *   sped up) by the integration's own setting, no idle back-off;
 *   `push: 'full'` is never scheduled. A batching integration (`batch: true`)
 *   has ONE schedule for the group — one due time, one read of every device
 *   per interval; a device that registers later joins the group's next tick.
 *   A non-batching integration keeps one schedule per device;
 * - command (`onCommand`, awaited by the D1022 seams): a polled device is read
 *   at once and the command returns after it, then read again at ~3 s and
 *   ~10 s, then every ~10 s with a last read ~2 s before it expires, for as
 *   long as a D1061 hold on it is still pending (the burst covers the hold's
 *   own limit, 30 s by default, up to 120 s); a push device waits
 *   `PUSH_CONFIRM_WINDOW_MS` for the confirming push and reads once if none
 *   came. These reads are per device and never move a batched group's schedule;
 * - push health: silence past `heartbeatMs` reads the integration, asks it to
 *   resubscribe and reads again; a new `connectionEpoch` reads everything.
 *
 * Reads of one device are serialized: each starts after the previous one on
 * that device ended. A scheduled tick that finds its last read still running
 * is skipped (debug line); a command waits for the read in flight at most
 * `COMMAND_WAIT_BOUND_MS`, then reads its own device (debug line). A refresh
 * failure is a warn line per device and never fails a command.
 */
import {
  commandBurstOffsets,
  effectiveRefreshIntervalMs,
  PUSH_CONFIRM_WINDOW_MS,
  type IScopedLogger,
  type StateRefreshPolicy,
  type StateRefreshReason,
} from '@camstack/types'
import type { CommandCallOutcome, CommandFollowUpTarget } from '../../kernel/command-follow-up.js'
import type { StateRefreshPolicyEntry } from '../../kernel/state-refresh-policies.js'

/** The registry surface the scheduler reads. */
export interface StateRefreshPolicySource {
  entries(): readonly StateRefreshPolicyEntry[]
  get(deviceId: number): StateRefreshPolicyEntry | undefined
  subscribe(listener: () => void): () => void
}

export interface StateRefreshSchedulerDeps {
  readonly policies: StateRefreshPolicySource
  readonly logger: IScopedLogger
  /** Whether a D1061 command hold on the device is still unconfirmed. */
  readonly holdsPending: (deviceId: number) => boolean
  /** How long the longest pending hold on the device still runs, in ms (0 when none). */
  readonly holdRemainingMs: (deviceId: number) => number
  /** Ask the provider to re-read `deviceIds`, routed through `routeDeviceId`. */
  readonly refresh: (
    routeDeviceId: number,
    deviceIds: readonly number[],
    reason: StateRefreshReason,
  ) => Promise<void>
  /** Ask the provider to re-establish its push subscription. */
  readonly resubscribe: (routeDeviceId: number) => Promise<void>
  /**
   * Told, in-process, which devices just had their FIRST read after
   * registration settle (D1099). Never an event: the same fact stays readable
   * through {@link StateRefreshScheduler.isAwaitingFirstRead}.
   */
  readonly onFirstReadSettled?: (deviceIds: readonly number[]) => void
  /**
   * The bound passed on a device whose every read failed: the provider is
   * silent, so the consumer concludes it offline, once (planning#710).
   */
  readonly onSilentPastBound?: (deviceId: number) => void
}

type Timer = ReturnType<typeof setTimeout>

/** The longest a command waits for a read already in flight on its device. */
export const COMMAND_WAIT_BOUND_MS = 5_000

/** The longest a device that keeps failing waits between two scheduled reads. */
export const FAILURE_BACKOFF_CAP_MS = 300_000

/**
 * The wait before the next scheduled read of a device that failed `failures`
 * reads in a row: the interval doubled per failure, capped, and never below
 * the interval itself.
 */
export function failureBackoffMs(intervalMs: number, failures: number): number {
  if (failures <= 0) return intervalMs
  return Math.max(intervalMs, Math.min(FAILURE_BACKOFF_CAP_MS, intervalMs * 2 ** failures))
}

interface DeviceSchedule {
  entry: StateRefreshPolicyEntry
  /** The device's own due time (a non-batching integration only). */
  dueAt: number
  lastReportAt: number
  lastCommandAt: number
  /** The last read queued or running on the device; `null` once it settled. */
  inFlight: Promise<void> | null
  /** The last scheduled read that included the device, while it runs. */
  scheduledInFlight: Promise<void> | null
  burst: Timer[]
  pushWindow: Timer | null
  /** Reads that failed in a row; a successful read resets it. */
  failures: number
  /**
   * No read of the device has settled since it registered (D1099): the
   * provider has not answered yet, so its state is unknown rather than
   * offline. What settles it is the first read that ANSWERED, the integration's
   * first state report after the (re)start (a full-push device is never read),
   * or the bound below. A failed read settles nothing.
   */
  awaitingFirstRead: boolean
  /** The device's bound: a dead integration is still concluded offline. */
  firstReportBound: Timer | null
}

/**
 * The longest an integration may stay silent after a (re)start before it counts
 * as having answered (D1099): past it, a dead integration is reported.
 */
export const FULL_PUSH_FIRST_REPORT_BOUND_MS = 120_000

interface GroupState {
  readonly key: string
  devices: Set<number>
  /** The group's due time (a batching integration only). */
  dueAt: number
  /** The interval `dueAt` was set from, to notice a policy change. */
  intervalMs: number
  scheduleTimer: Timer | null
  heartbeatTimer: Timer | null
  lastReportAt: number
  /**
   * The integration just (re)appeared and has not answered yet (D1099): its
   * siblings' offline is held. Set once, when the group is created (hub boot,
   * or the integration's runner came back with no settled entries); cleared
   * when no device of it awaits any more and NEVER set again — a device
   * hot-added to a settled integration gates only itself.
   */
  gated: boolean
}

/**
 * The caps the FRAMEWORK writes on a device while it registers and activates,
 * before the provider has said anything about the entity: the liveness claim
 * under judgement, the `feature-probe` seed / `onProbe` stamp, and the
 * `device-admin-link` answer. A report of one of these is never a full-push
 * device's first state (D1099); only a cap the provider's own state path
 * writes is. One named set — a new framework seed is added here, and the
 * real-activation spec of the Home Assistant child fails until it is.
 */
export const FRAMEWORK_STATE_CAPS: ReadonlySet<string> = new Set([
  'device-status',
  'feature-probe',
  'device-admin-link',
])

/** The key one integration instance is scheduled under: `addonId::integrationId`. */
export function integrationGroupKey(addonId: string, integrationId: string): string {
  return `${addonId}::${integrationId}`
}

function groupKeyOf(entry: StateRefreshPolicyEntry): string {
  return integrationGroupKey(entry.addonId, entry.policy.integrationId)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class StateRefreshScheduler {
  private readonly devices = new Map<number, DeviceSchedule>()
  private readonly groups = new Map<string, GroupState>()
  /** The latest connection epoch seen per integration, kept while its group is gone. */
  private readonly epochs = new Map<string, number>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly deps: StateRefreshSchedulerDeps) {
    this.unsubscribe = deps.policies.subscribe(() => this.reconcile())
    this.reconcile()
  }

  /** The command follow-up (awaited by the D1022 seams; never throws). */
  readonly onCommand = async (
    target: CommandFollowUpTarget,
    outcome: CommandCallOutcome,
  ): Promise<void> => {
    const device = this.devices.get(target.deviceId)
    if (device === undefined || this.disposed) return
    device.lastCommandAt = Date.now()
    this.cancelFollowUps(device)
    const { policy } = device.entry
    if (policy.push !== 'none') {
      this.armPushWindow(target.deviceId, device)
      return
    }
    this.deps.logger.debug('state refresh after command', {
      tags: { deviceId: target.deviceId },
      meta: { capName: target.capName, method: target.method, outcome },
    })
    await this.runRefresh([target.deviceId], 'command', COMMAND_WAIT_BOUND_MS)
    if (!policy.batch) {
      device.dueAt = Date.now() + effectiveRefreshIntervalMs(policy)
      this.armSchedule(groupKeyOf(device.entry))
    }
    this.armBurst(target.deviceId, device)
  }

  /**
   * A state report reached the mirror for `deviceId` (push or read). The first
   * state of a full-push device (any cap but its own liveness, which is the
   * claim being judged) is its answer. Only THAT device settles: its siblings'
   * cache replay is still on its way, and their held offline must not be
   * released before it (the integration stays awaiting until each one answered
   * or the bound passed).
   */
  onReport(deviceId: number, capName?: string): void {
    const device = this.devices.get(deviceId)
    if (device === undefined) return
    if (device.awaitingFirstRead && capName !== undefined && !FRAMEWORK_STATE_CAPS.has(capName)) {
      this.deps.logger.info('state refresh: first state from the integration, device answered', {
        tags: { deviceId },
      })
      this.settleFirstRead([deviceId])
    }
    const now = Date.now()
    device.lastReportAt = now
    const group = this.groups.get(groupKeyOf(device.entry))
    if (group !== undefined) group.lastReportAt = now
  }

  /**
   * Whether the device's provider has yet to answer its first read since the
   * device registered (D1099). A read of this scheduler's own state, safe to
   * ask at any time; a device it does not schedule is never awaiting.
   */
  isAwaitingFirstRead(deviceId: number): boolean {
    return this.devices.get(deviceId)?.awaitingFirstRead === true
  }

  /**
   * Whether the integration (`integrationGroupKey`) still has a scheduled
   * device whose provider has not answered its first read (D1099). The
   * integration's policy is registered once, on its gateway/broker cap; the
   * child devices that carry no policy of their own are judged through it.
   */
  isIntegrationAwaitingFirstRead(key: string): boolean {
    return this.groups.get(key)?.gated === true
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const device of this.devices.values()) {
      this.cancelFollowUps(device)
      this.clearFirstReportBound(device)
    }
    for (const group of this.groups.values()) this.clearGroupTimers(group)
    this.devices.clear()
    this.groups.clear()
    this.epochs.clear()
  }

  // ── reconcile ────────────────────────────────────────────────────

  private reconcile(): void {
    if (this.disposed) return
    const now = Date.now()
    const current = new Map(this.deps.policies.entries().map((e) => [e.deviceId, e] as const))
    for (const [deviceId, device] of this.devices) {
      if (current.has(deviceId)) continue
      this.cancelFollowUps(device)
      this.clearFirstReportBound(device)
      this.devices.delete(deviceId)
    }
    const reconnected = new Set<string>()
    for (const entry of current.values()) {
      const existing = this.devices.get(entry.deviceId)
      const interval = effectiveRefreshIntervalMs(entry.policy)
      if (existing === undefined) {
        this.devices.set(entry.deviceId, {
          entry,
          dueAt: now + interval,
          lastReportAt: now,
          lastCommandAt: 0,
          inFlight: null,
          scheduledInFlight: null,
          burst: [],
          pushWindow: null,
          failures: 0,
          awaitingFirstRead: true,
          firstReportBound: null,
        })
        this.armFirstReportBound(entry.deviceId)
      } else {
        if (effectiveRefreshIntervalMs(existing.entry.policy) !== interval)
          existing.dueAt = now + interval
        existing.entry = entry
      }
      if (this.noteEpoch(entry)) reconnected.add(groupKeyOf(entry))
    }
    this.rebuildGroups(now)
    if (this.ungateSettledGroups()) this.deps.onFirstReadSettled?.([])
    for (const key of reconnected) {
      this.deps.logger.info('state refresh: integration reconnected, reading every device', {
        meta: { group: key },
      })
      void this.refreshGroup(key, 'schedule')
    }
  }

  /**
   * Track an integration's connection epoch; `true` when it CHANGED. Any change
   * is a reconnect, a restart that comes back with a lower value included (a
   * provider's counter restarts with its process while this scheduler keeps
   * running). The first registration and an unchanged epoch read nothing.
   *
   * The value is kept across a gap on purpose, and NOT dropped when the last
   * device of an integration leaves: a provider re-registers its cap to publish
   * the new epoch, which removes the device for a moment, and the comparison
   * must still see the epoch from before. It is forgotten in `dispose()`.
   */
  private noteEpoch(entry: StateRefreshPolicyEntry): boolean {
    const epoch = entry.policy.connectionEpoch
    if (epoch === undefined) return false
    const key = groupKeyOf(entry)
    const previous = this.epochs.get(key)
    this.epochs.set(key, epoch)
    return previous !== undefined && epoch !== previous
  }

  private rebuildGroups(now: number): void {
    const members = new Map<string, Set<number>>()
    for (const [deviceId, device] of this.devices) {
      const key = groupKeyOf(device.entry)
      const set = members.get(key) ?? new Set<number>()
      set.add(deviceId)
      members.set(key, set)
    }
    for (const [key, group] of this.groups) {
      if (members.has(key)) continue
      this.clearGroupTimers(group)
      this.groups.delete(key)
    }
    for (const [key, devices] of members) {
      const existing = this.groups.get(key)
      if (existing === undefined) {
        const first = this.devices.get([...devices][0] ?? -1)
        const intervalMs = first === undefined ? 0 : effectiveRefreshIntervalMs(first.entry.policy)
        this.groups.set(key, {
          key,
          devices,
          dueAt: now + intervalMs,
          intervalMs,
          scheduleTimer: null,
          heartbeatTimer: null,
          lastReportAt: now,
          gated: true,
        })
      } else {
        existing.devices = devices
        const policy = this.groupPolicy(existing)
        const intervalMs = policy === undefined ? 0 : effectiveRefreshIntervalMs(policy)
        if (intervalMs !== existing.intervalMs) {
          existing.intervalMs = intervalMs
          existing.dueAt = now + intervalMs
        }
      }
      this.armSchedule(key)
      this.armHeartbeat(key)
    }
  }

  // ── the schedule ─────────────────────────────────────────────────

  private groupPolicy(group: GroupState): StateRefreshPolicy | undefined {
    for (const deviceId of group.devices) {
      const device = this.devices.get(deviceId)
      if (device !== undefined) return device.entry.policy
    }
    return undefined
  }

  private armSchedule(key: string): void {
    const group = this.groups.get(key)
    if (group === undefined || this.disposed) return
    if (group.scheduleTimer !== null) clearTimeout(group.scheduleTimer)
    group.scheduleTimer = null
    const policy = this.groupPolicy(group)
    if (policy === undefined || policy.push === 'full') return
    let earliest = Number.POSITIVE_INFINITY
    if (policy.batch) earliest = group.dueAt
    else {
      for (const deviceId of group.devices) {
        const device = this.devices.get(deviceId)
        if (device !== undefined) earliest = Math.min(earliest, device.dueAt)
      }
    }
    if (!Number.isFinite(earliest)) return
    group.scheduleTimer = setTimeout(() => this.tick(key), Math.max(0, earliest - Date.now()))
  }

  private tick(key: string): void {
    const group = this.groups.get(key)
    if (group === undefined || this.disposed) return
    group.scheduleTimer = null
    const policy = this.groupPolicy(group)
    if (policy?.batch === true) this.tickBatched(group, policy)
    else this.tickPerDevice(group)
    this.armSchedule(key)
  }

  /** One read of the whole group per interval, unless the last one still runs. */
  private tickBatched(group: GroupState, policy: StateRefreshPolicy): void {
    const now = Date.now()
    if (group.dueAt > now) return
    group.dueAt = now + effectiveRefreshIntervalMs(policy)
    const ids = [...group.devices].filter((id) => this.devices.has(id))
    const running = ids.filter((id) => (this.devices.get(id)?.scheduledInFlight ?? null) !== null)
    if (running.length > 0) {
      for (const deviceId of running) this.logSkippedTick(deviceId)
      return
    }
    if (ids.length > 0) void this.runScheduled(ids)
  }

  private tickPerDevice(group: GroupState): void {
    const now = Date.now()
    const due: number[] = []
    for (const deviceId of group.devices) {
      const device = this.devices.get(deviceId)
      if (device === undefined || device.dueAt > now) continue
      device.dueAt = now + effectiveRefreshIntervalMs(device.entry.policy)
      if (device.inFlight !== null) {
        this.logSkippedTick(deviceId)
        continue
      }
      due.push(deviceId)
    }
    for (const deviceId of due) void this.runScheduled([deviceId])
  }

  private logSkippedTick(deviceId: number): void {
    this.deps.logger.debug('state refresh skipped: a refresh is still in flight', {
      tags: { deviceId },
    })
  }

  /** A scheduled read, remembered on each device until it settles. */
  private async runScheduled(deviceIds: readonly number[]): Promise<void> {
    const run = this.runRefresh(deviceIds, 'schedule')
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device !== undefined) device.scheduledInFlight = run
    }
    await run
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device !== undefined && device.scheduledInFlight === run) device.scheduledInFlight = null
    }
  }

  // ── command follow-ups ───────────────────────────────────────────

  private armBurst(deviceId: number, device: DeviceSchedule): void {
    if (!this.deps.holdsPending(deviceId)) return
    const timers: Timer[] = []
    let stopped = false
    for (const offset of commandBurstOffsets(this.deps.holdRemainingMs(deviceId))) {
      timers.push(
        setTimeout(() => {
          if (stopped || this.disposed) return
          if (!this.deps.holdsPending(deviceId)) {
            stopped = true
            this.deps.logger.debug('state refresh burst stopped: the command is confirmed', {
              tags: { deviceId },
            })
            return
          }
          if (device.inFlight !== null) {
            this.deps.logger.debug('state refresh burst skipped: a refresh is still in flight', {
              tags: { deviceId },
            })
            return
          }
          void this.runRefresh([deviceId], 'burst')
        }, offset),
      )
    }
    device.burst = timers
  }

  private armPushWindow(deviceId: number, device: DeviceSchedule): void {
    const commandAt = device.lastCommandAt
    device.pushWindow = setTimeout(() => {
      device.pushWindow = null
      if (this.disposed) return
      if (device.lastReportAt > commandAt && !this.deps.holdsPending(deviceId)) {
        this.deps.logger.debug('state refresh not needed: the push confirmed the command', {
          tags: { deviceId },
        })
        return
      }
      this.deps.logger.debug('state refresh: no confirming push within the window', {
        tags: { deviceId },
        meta: { windowMs: PUSH_CONFIRM_WINDOW_MS },
      })
      if (device.inFlight !== null) return
      void this.runRefresh([deviceId], 'command')
    }, PUSH_CONFIRM_WINDOW_MS)
  }

  private clearFirstReportBound(device: DeviceSchedule): void {
    if (device.firstReportBound !== null) clearTimeout(device.firstReportBound)
    device.firstReportBound = null
  }

  private armFirstReportBound(deviceId: number): void {
    const device = this.devices.get(deviceId)
    if (device === undefined || this.disposed) return
    device.firstReportBound = setTimeout(() => {
      device.firstReportBound = null
      if (this.disposed || !device.awaitingFirstRead) return
      this.deps.logger.info('state refresh: no first state from the integration within the bound', {
        tags: { deviceId },
        meta: { boundMs: FULL_PUSH_FIRST_REPORT_BOUND_MS },
      })
      const failedReads = device.failures > 0
      this.settleFirstRead([deviceId])
      if (failedReads) this.deps.onSilentPastBound?.(deviceId)
    }, FULL_PUSH_FIRST_REPORT_BOUND_MS)
  }

  private cancelFollowUps(device: DeviceSchedule): void {
    for (const timer of device.burst) clearTimeout(timer)
    device.burst = []
    if (device.pushWindow !== null) clearTimeout(device.pushWindow)
    device.pushWindow = null
  }

  // ── push health ──────────────────────────────────────────────────

  private armHeartbeat(key: string): void {
    const group = this.groups.get(key)
    if (group === undefined || this.disposed) return
    if (group.heartbeatTimer !== null) clearTimeout(group.heartbeatTimer)
    group.heartbeatTimer = null
    const policy = this.groupPolicy(group)
    if (policy === undefined || policy.push === 'none' || policy.heartbeatMs === undefined) return
    const heartbeatMs = policy.heartbeatMs
    const wait = Math.max(0, group.lastReportAt + heartbeatMs - Date.now())
    group.heartbeatTimer = setTimeout(() => {
      group.heartbeatTimer = null
      if (this.disposed) return
      if (Date.now() - group.lastReportAt >= heartbeatMs) void this.onSilence(key, heartbeatMs)
      else this.armHeartbeat(key)
    }, wait)
  }

  private async onSilence(key: string, heartbeatMs: number): Promise<void> {
    const group = this.groups.get(key)
    if (group === undefined) return
    group.lastReportAt = Date.now()
    for (const deviceId of group.devices) {
      this.deps.logger.warn(
        'state refresh: no push within the heartbeat, reading and resubscribing',
        {
          tags: { deviceId },
          meta: { heartbeatMs },
        },
      )
    }
    await this.refreshGroup(key, 'schedule')
    const route = [...group.devices][0]
    if (route !== undefined) {
      try {
        await this.deps.resubscribe(route)
      } catch (err: unknown) {
        this.deps.logger.warn('state refresh: resubscribe failed', {
          tags: { deviceId: route },
          meta: { error: errorMessage(err) },
        })
      }
    }
    await this.refreshGroup(key, 'schedule')
    this.armHeartbeat(key)
  }

  // ── refresh calls ────────────────────────────────────────────────

  private async refreshGroup(key: string, reason: StateRefreshReason): Promise<void> {
    const group = this.groups.get(key)
    if (group === undefined) return
    const ids = [...group.devices].filter((id) => this.devices.has(id))
    if (ids.length > 0) await this.refreshDevices(ids, reason)
  }

  /** One call for a batching integration, else one per device. */
  private async refreshDevices(
    deviceIds: readonly number[],
    reason: StateRefreshReason,
  ): Promise<void> {
    const first = this.devices.get(deviceIds[0] ?? -1)
    if (first?.entry.policy.batch === true) {
      await this.runRefresh(deviceIds, reason)
      return
    }
    await Promise.all(deviceIds.map((id) => this.runRefresh([id], reason)))
  }

  /**
   * Read `deviceIds` once every read already queued on them ended — or, with
   * `waitBoundMs`, once that long passed (a debug line per device that was
   * still busy). The read becomes the devices' new tail.
   */
  private async runRefresh(
    deviceIds: readonly number[],
    reason: StateRefreshReason,
    waitBoundMs?: number,
  ): Promise<void> {
    const route = deviceIds[0]
    if (route === undefined) return
    const busy: number[] = []
    const prior: Promise<void>[] = []
    for (const deviceId of deviceIds) {
      const tail = this.devices.get(deviceId)?.inFlight
      if (tail === null || tail === undefined) continue
      busy.push(deviceId)
      prior.push(tail)
    }
    const settled = this.afterPrior(prior, busy, waitBoundMs)
      .then(async () => {
        await this.deps.refresh(route, deviceIds, reason)
        this.noteSuccess(deviceIds)
        // A read that ANSWERED is the first state. A FAILED one is not: the
        // integration may still be starting (unknown, never offline); the
        // state report or the bound settles it.
        this.settleFirstRead(deviceIds)
      })
      .catch((err: unknown) => this.noteFailure(deviceIds, reason, err))
      .finally(() => {
        for (const deviceId of deviceIds) {
          const device = this.devices.get(deviceId)
          if (device !== undefined && device.inFlight === settled) device.inFlight = null
        }
      })
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device !== undefined) device.inFlight = settled
    }
    await settled
  }

  /** Open every gated integration none of whose devices awaits any more; whether any opened. */
  private ungateSettledGroups(): boolean {
    let opened = false
    for (const group of this.groups.values()) {
      if (!group.gated) continue
      if ([...group.devices].some((id) => this.devices.get(id)?.awaitingFirstRead)) continue
      group.gated = false
      opened = true
    }
    return opened
  }

  /**
   * A read answered, a state report arrived or the bound passed (a failed read
   * settles nothing: unknown is not offline). The devices stop awaiting and the
   * consumer is told.
   */
  private settleFirstRead(deviceIds: readonly number[]): void {
    const ready: number[] = []
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device === undefined || !device.awaitingFirstRead) continue
      device.awaitingFirstRead = false
      this.clearFirstReportBound(device)
      ready.push(deviceId)
    }
    const ungated = this.ungateSettledGroups()
    if (ready.length > 0 || ungated) this.deps.onFirstReadSettled?.(ready)
  }

  /**
   * A read that succeeded ends a backoff: the device is due at the declared
   * interval from now, whichever read (schedule, command, burst) proved it.
   */
  private noteSuccess(deviceIds: readonly number[]): void {
    const now = Date.now()
    const keys = new Set<string>()
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device === undefined || device.failures === 0) continue
      this.deps.logger.info('state refresh recovered: back to the declared interval', {
        tags: { deviceId },
        meta: { failedReads: device.failures },
      })
      device.failures = 0
      const intervalMs = effectiveRefreshIntervalMs(device.entry.policy)
      if (!device.entry.policy.batch) device.dueAt = now + intervalMs
      keys.add(groupKeyOf(device.entry))
    }
    for (const key of keys) {
      const group = this.groups.get(key)
      const policy = group === undefined ? undefined : this.groupPolicy(group)
      if (group !== undefined && policy?.batch === true) {
        group.dueAt = now + effectiveRefreshIntervalMs(policy)
      }
      this.armSchedule(key)
    }
  }

  /**
   * A failed read is a warn per device. Only a SCHEDULED read that failed backs
   * the device off (doubling from the interval, capped, reset by the next
   * success): a command or burst read has its own cadence and says nothing
   * about the scheduled one. A batched group backs off only when the failed
   * read covered the whole group.
   */
  private noteFailure(
    deviceIds: readonly number[],
    reason: StateRefreshReason,
    err: unknown,
  ): void {
    const now = Date.now()
    const scheduled = reason === 'schedule'
    const keys = new Set<string>()
    let groupFailures = 0
    for (const deviceId of deviceIds) {
      const device = this.devices.get(deviceId)
      if (device === undefined) continue
      if (scheduled) device.failures += 1
      groupFailures = Math.max(groupFailures, device.failures)
      const intervalMs = effectiveRefreshIntervalMs(device.entry.policy)
      const retryInMs = failureBackoffMs(intervalMs, device.failures)
      if (scheduled && !device.entry.policy.batch) {
        device.dueAt = Math.max(device.dueAt, now + retryInMs)
      }
      keys.add(groupKeyOf(device.entry))
      this.deps.logger.warn('state refresh failed', {
        tags: { deviceId },
        meta: {
          reason,
          error: errorMessage(err),
          consecutiveFailures: device.failures,
          retryInMs: scheduled && device.entry.policy.push !== 'full' ? retryInMs : undefined,
        },
      })
    }
    if (!scheduled) return
    for (const key of keys) {
      const group = this.groups.get(key)
      const policy = group === undefined ? undefined : this.groupPolicy(group)
      if (group !== undefined && policy?.batch === true) {
        const wholeGroup = [...group.devices].every((id) => deviceIds.includes(id))
        if (wholeGroup) {
          group.dueAt = Math.max(
            group.dueAt,
            now + failureBackoffMs(effectiveRefreshIntervalMs(policy), groupFailures),
          )
        }
      }
      this.armSchedule(key)
    }
  }

  /** Resolves when every `prior` read ended, or after `waitBoundMs` (logged per busy device). */
  private async afterPrior(
    prior: readonly Promise<void>[],
    busy: readonly number[],
    waitBoundMs: number | undefined,
  ): Promise<void> {
    if (prior.length === 0) return
    const all = Promise.all(prior).then(() => true)
    if (waitBoundMs === undefined) {
      await all
      return
    }
    let timer: Timer | undefined
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitBoundMs)
    })
    const ended = await Promise.race([all, bound])
    if (timer !== undefined) clearTimeout(timer)
    if (ended) return
    for (const deviceId of busy) {
      this.deps.logger.debug('state refresh: stopped waiting for the read in flight', {
        tags: { deviceId },
        meta: { waitedMs: waitBoundMs },
      })
    }
  }

  private clearGroupTimers(group: GroupState): void {
    if (group.scheduleTimer !== null) clearTimeout(group.scheduleTimer)
    if (group.heartbeatTimer !== null) clearTimeout(group.heartbeatTimer)
    group.scheduleTimer = null
    group.heartbeatTimer = null
  }
}
