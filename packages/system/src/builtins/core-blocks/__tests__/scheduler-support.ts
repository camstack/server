/** A fake hub, fake clock and engine harness for the scheduler specs. */
import {
  type CapCall,
  DeviceType,
  createRecordsAccess,
  type AutomationRunTrace,
  type DeviceDirectory,
  type DirectoryDevice,
  ActionTargetResolver,
  type SchedulerInput,
  type SchedulerOutcome,
  type SiteReading,
} from '@camstack/types'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { SchedulerEngine } from '../scheduler/scheduler-engine.js'
import { SchedulersStore } from '../scheduler/scheduler-store.js'
import type { SchedulerClock, SchedulerHost } from '../scheduler/scheduler-types.js'
import { recordingLogger } from './fixtures.js'

export const ROME: SiteReading = {
  location: { latitude: 41.9, longitude: 12.5 },
  timeZone: 'Europe/Rome',
}

interface Timer {
  readonly at: number
  readonly fn: () => void
}

/** A clock that only moves when the spec says so; due timers fire in order. */
export class FakeClock implements SchedulerClock {
  private t: number
  readonly timers = new Set<Timer>()
  constructor(start: number) {
    this.t = start
  }
  now(): number {
    return this.t
  }
  setTimer(fn: () => void, ms: number): Timer {
    const timer = { at: this.t + ms, fn }
    this.timers.add(timer)
    return timer
  }
  clearTimer(handle: unknown): void {
    for (const timer of this.timers) if (timer === handle) this.timers.delete(timer)
  }
  /** Move to `target`, firing every timer due on the way, each at its own instant. */
  async advanceTo(target: number, settle: () => Promise<void>): Promise<void> {
    for (;;) {
      const due = [...this.timers].filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      this.timers.delete(due)
      this.t = Math.max(this.t, due.at)
      due.fn()
      await settle()
    }
    this.t = target
    await settle()
  }
}

export interface Seen {
  readonly schedulerId: string
  readonly outcome: SchedulerOutcome | undefined
  readonly trace: AutomationRunTrace
}

export interface Device {
  readonly id: number
  readonly type?: DeviceType
  readonly location?: string | null
}

export interface Harness {
  readonly clock: FakeClock
  readonly engine: SchedulerEngine
  readonly targets: ActionTargetResolver
  readonly store: SchedulersStore
  readonly calls: CapCall[]
  readonly seen: Seen[]
  readonly logs: ReturnType<typeof recordingLogger>
  /** The device state the fake hub holds, `${deviceId}|${cap}` → slice. */
  readonly slices: Map<string, Record<string, unknown>>
  /** Devices a domain target resolves to. */
  readonly devices: DirectoryDevice[]
  /** When true, a write is accepted but the state does not follow (drift). */
  ignoreWrites: { value: boolean }
  site: { value: SiteReading | null }
  create(input: SchedulerInput): Promise<string>
  settle(): Promise<void>
  advanceTo(ms: number): Promise<void>
  /** The device changes state on its own (not caused by CamStack). */
  manual(deviceId: number, cap: string, slice: Record<string, unknown>): Promise<void>
  outcomes(id?: string): SchedulerOutcome[]
}

export interface HarnessOptions {
  readonly start: number
  readonly devices?: readonly Device[]
  readonly settleMs?: number
  readonly seed?: ReadonlyMap<string, Record<string, unknown>>
}

export async function harness(options: HarnessOptions): Promise<Harness> {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const log = recordingLogger()
  const clock = new FakeClock(options.start)
  let ids = 0
  const store = new SchedulersStore({
    schedulers: records.kind(coreBlocksRecordKinds.schedulers),
    state: records.kind(coreBlocksRecordKinds['scheduler-state']),
    now: () => clock.now(),
    newId: () => `s${(ids += 1)}`,
  })
  const slices = new Map<string, Record<string, unknown>>(options.seed ?? [])
  const devices: DirectoryDevice[] = (options.devices ?? []).map((d) => ({
    id: d.id,
    type: d.type ?? DeviceType.Switch,
    location: d.location ?? null,
    disabled: false,
  }))
  const calls: CapCall[] = []
  const ignoreWrites = { value: false }
  const site: { value: SiteReading | null } = { value: ROME }
  const directory: DeviceDirectory = {
    listDeviceIdsByCaps: async () => devices.map((d) => d.id),
    listDevices: async (idsIn) => devices.filter((d) => idsIn.includes(d.id)),
  }
  let engineRef: SchedulerEngine | null = null
  const host: SchedulerHost = {
    readSite: async () => {
      if (site.value === null) throw new Error('no system cap yet')
      return site.value
    },
    fetchSlice: async (deviceId, cap) => slices.get(`${deviceId}|${cap}`) ?? {},
    fetchStableIds: async () => new Map(),
    invokeCap: async (call) => {
      calls.push(call)
      if (ignoreWrites.value) return
      const next = {
        ...slices.get(`${call.deviceId}|${call.cap}`),
        ...call.args,
      }
      slices.set(`${call.deviceId}|${call.cap}`, next)
      engineRef?.onDeviceState(call.deviceId, call.cap, next)
    },
  }
  const seen: Seen[] = []
  const targets = new ActionTargetResolver(directory, log.logger)
  const engine = new SchedulerEngine({
    store,
    host,
    targets,
    logger: log.logger,
    clock,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    record: async (schedulerId, trace) => {
      seen.push({ schedulerId, outcome: trace.scheduler, trace })
    },
  })
  engineRef = engine
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await engine.idle()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return {
    clock,
    engine,
    targets,
    store,
    calls,
    seen,
    logs: log,
    slices,
    devices,
    ignoreWrites,
    site,
    create: async (input) => (await store.create(input)).id,
    settle,
    advanceTo: (ms) => clock.advanceTo(ms, settle),
    manual: async (deviceId, cap, slice) => {
      slices.set(`${deviceId}|${cap}`, slice)
      engine.onDeviceState(deviceId, cap, slice)
      await settle()
    },
    outcomes: (id) =>
      seen
        .filter((s) => id === undefined || s.schedulerId === id)
        .flatMap((s) => (s.outcome === undefined ? [] : [s.outcome])),
  }
}

export const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** Local Rome time on a date to epoch ms (winter +01:00, summer +02:00 given explicitly). */
export function at(iso: string): number {
  return Date.parse(iso)
}
