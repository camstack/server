/**
 * The state-refresh scheduler (D1062): the core decides WHEN a migrated
 * provider re-reads a device; the provider only knows HOW.
 *
 * One schedule per (integration instance, device), grouped per integration so
 * a provider that reads in batch is asked once per tick. The policy each
 * provider declared on its `device-state-refresh` registration
 * (`StateRefreshPolicyRegistry`) drives it:
 *
 * - cadence: `effectiveRefreshIntervalMs` — the declared minimum, slowed (never
 *   sped up) by the integration's own setting, no idle back-off;
 *   `push: 'full'` is never scheduled;
 * - command (`onCommand`, awaited by the D1022 seams): a polled device is read
 *   at once and the command returns after it, then read again at ~3 s and
 *   ~10 s while a D1061 hold on it is still pending; a push device waits
 *   `PUSH_CONFIRM_WINDOW_MS` for the confirming push and reads once if none
 *   came;
 * - push health: silence past `heartbeatMs` reads the integration, asks it to
 *   resubscribe and reads again; a new `connectionEpoch` reads everything.
 *
 * Refreshes of one device never overlap: a tick that finds one in flight is
 * skipped (debug line), a command waits for it. A refresh failure is a warn
 * line per device and never fails a command.
 */
import {
  COMMAND_BURST_OFFSETS_MS,
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
  /** Ask the provider to re-read `deviceIds`, routed through `routeDeviceId`. */
  readonly refresh: (
    routeDeviceId: number,
    deviceIds: readonly number[],
    reason: StateRefreshReason,
  ) => Promise<void>
  /** Ask the provider to re-establish its push subscription. */
  readonly resubscribe: (routeDeviceId: number) => Promise<void>
}

type Timer = ReturnType<typeof setTimeout>

interface DeviceSchedule {
  entry: StateRefreshPolicyEntry
  dueAt: number
  lastReportAt: number
  lastCommandAt: number
  inFlight: Promise<void> | null
  burst: Timer[]
  pushWindow: Timer | null
}

interface GroupState {
  readonly key: string
  devices: Set<number>
  scheduleTimer: Timer | null
  heartbeatTimer: Timer | null
  lastReportAt: number
  epoch: number | undefined
}

function groupKeyOf(entry: StateRefreshPolicyEntry): string {
  return `${entry.addonId}::${entry.policy.integrationId}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class StateRefreshScheduler {
  private readonly devices = new Map<number, DeviceSchedule>()
  private readonly groups = new Map<string, GroupState>()
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
    if (device.inFlight !== null) await device.inFlight
    this.deps.logger.debug('state refresh after command', {
      tags: { deviceId: target.deviceId },
      meta: { capName: target.capName, method: target.method, outcome },
    })
    await this.runRefresh([target.deviceId], 'command')
    device.dueAt = Date.now() + effectiveRefreshIntervalMs(policy)
    this.armSchedule(groupKeyOf(device.entry))
    this.armBurst(target.deviceId, device)
  }

  /** A state report reached the mirror for `deviceId` (push or read). */
  onReport(deviceId: number): void {
    const device = this.devices.get(deviceId)
    if (device === undefined) return
    const now = Date.now()
    device.lastReportAt = now
    const group = this.groups.get(groupKeyOf(device.entry))
    if (group !== undefined) group.lastReportAt = now
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const device of this.devices.values()) this.cancelFollowUps(device)
    for (const group of this.groups.values()) this.clearGroupTimers(group)
    this.devices.clear()
    this.groups.clear()
  }

  // ── reconcile ────────────────────────────────────────────────────

  private reconcile(): void {
    if (this.disposed) return
    const now = Date.now()
    const current = new Map(this.deps.policies.entries().map((e) => [e.deviceId, e] as const))
    for (const [deviceId, device] of this.devices) {
      if (current.has(deviceId)) continue
      this.cancelFollowUps(device)
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
          burst: [],
          pushWindow: null,
        })
      } else {
        if (effectiveRefreshIntervalMs(existing.entry.policy) !== interval)
          existing.dueAt = now + interval
        existing.entry = entry
      }
      if (this.noteEpoch(entry)) reconnected.add(groupKeyOf(entry))
    }
    this.rebuildGroups(now)
    for (const key of reconnected) {
      this.deps.logger.info('state refresh: integration reconnected, reading every device', {
        meta: { group: key },
      })
      void this.refreshGroup(key, 'schedule')
    }
  }

  /** Track the group's connection epoch; `true` when it moved past a known one. */
  private noteEpoch(entry: StateRefreshPolicyEntry): boolean {
    const epoch = entry.policy.connectionEpoch
    if (epoch === undefined) return false
    const key = groupKeyOf(entry)
    const group = this.groups.get(key)
    if (group === undefined) return false
    const previous = group.epoch
    if (previous === undefined || epoch > previous) group.epoch = epoch
    return previous !== undefined && epoch > previous
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
        this.groups.set(key, {
          key,
          devices,
          scheduleTimer: null,
          heartbeatTimer: null,
          lastReportAt: now,
          epoch: first?.entry.policy.connectionEpoch,
        })
      } else {
        existing.devices = devices
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
    let earliest = Number.POSITIVE_INFINITY
    for (const deviceId of group.devices) {
      const device = this.devices.get(deviceId)
      if (device === undefined || device.entry.policy.push === 'full') continue
      earliest = Math.min(earliest, device.dueAt)
    }
    if (!Number.isFinite(earliest)) return
    group.scheduleTimer = setTimeout(() => this.tick(key), Math.max(0, earliest - Date.now()))
  }

  private tick(key: string): void {
    const group = this.groups.get(key)
    if (group === undefined || this.disposed) return
    group.scheduleTimer = null
    const now = Date.now()
    const due: number[] = []
    for (const deviceId of group.devices) {
      const device = this.devices.get(deviceId)
      if (device === undefined || device.entry.policy.push === 'full' || device.dueAt > now)
        continue
      device.dueAt = now + effectiveRefreshIntervalMs(device.entry.policy)
      if (device.inFlight !== null) {
        this.deps.logger.debug('state refresh skipped: a refresh is still in flight', {
          tags: { deviceId },
        })
        continue
      }
      due.push(deviceId)
    }
    if (due.length > 0) void this.refreshDevices(due, 'schedule')
    this.armSchedule(key)
  }

  // ── command follow-ups ───────────────────────────────────────────

  private armBurst(deviceId: number, device: DeviceSchedule): void {
    if (!this.deps.holdsPending(deviceId)) return
    const timers: Timer[] = []
    let stopped = false
    for (const offset of COMMAND_BURST_OFFSETS_MS) {
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
    const idle: number[] = []
    for (const deviceId of group.devices) {
      const device = this.devices.get(deviceId)
      if (device === undefined) continue
      if (device.inFlight !== null) await device.inFlight
      idle.push(deviceId)
    }
    if (idle.length > 0) await this.refreshDevices(idle, reason)
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

  private async runRefresh(
    deviceIds: readonly number[],
    reason: StateRefreshReason,
  ): Promise<void> {
    const route = deviceIds[0]
    if (route === undefined) return
    const call = this.deps.refresh(route, deviceIds, reason).catch((err: unknown) => {
      for (const deviceId of deviceIds) {
        this.deps.logger.warn('state refresh failed', {
          tags: { deviceId },
          meta: { reason, error: errorMessage(err) },
        })
      }
    })
    const settled = call.finally(() => {
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

  private clearGroupTimers(group: GroupState): void {
    if (group.scheduleTimer !== null) clearTimeout(group.scheduleTimer)
    if (group.heartbeatTimer !== null) clearTimeout(group.heartbeatTimer)
    group.scheduleTimer = null
    group.heartbeatTimer = null
  }
}
