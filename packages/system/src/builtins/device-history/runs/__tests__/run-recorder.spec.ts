/**
 * The run recorder over the REAL records engine (two in-memory SQLite files, the
 * real provider): a run is a row that must survive a restart, end with
 * `counter at end - counter at start`, and never be duplicated by the boot
 * reconcile. Only the hub (snapshots, meter slices, device types) and time are
 * stand-ins.
 */
import {
  createRecordsAccess,
  type DeviceRun,
  DeviceType,
  type EventCategory,
  type RecordKindHandle,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  makeRecordsWorld,
  type RecordsWorld,
} from '../../../sqlite-storage/__tests__/support/records-world.js'
import { type CapturedLog, recordingLogger } from '../../__tests__/support/real-door.js'
import type { SnapshotMap } from '../../capture/capture-engine.js'
import { createDeviceRunsProvider } from '../device-runs-provider.js'
import { deviceRunsRecordKinds } from '../device-runs-record-kinds.js'
import { RunRecorder, type RunRecorderDeps } from '../run-recorder.js'
import type { Slice } from '../slice-readers.js'

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0)
const MIN = 60_000
const WASHER = 7
const DISHWASHER = 8
const LAMP = 9

interface Rig {
  readonly world: RecordsWorld
  readonly logs: CapturedLog[]
  readonly events: { category: EventCategory; run: DeviceRun }[]
  readonly slices: Map<string, Slice>
  readonly types: Map<number, DeviceType>
  snapshots: SnapshotMap | Error
  now: number
  historyKwh: number | null
  historyCalls: number
  runs(): Promise<RecordKindHandle<DeviceRun>>
  recorder(): RunRecorder
}

async function makeRig(): Promise<Rig> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'device-history',
    transport: world.transportFor('device-history'),
    secrets: null,
  })
  await records.declare(deviceRunsRecordKinds)
  const handle = records.kind(deviceRunsRecordKinds['device-runs'])
  const rig: Rig = {
    world,
    logs: [],
    events: [],
    slices: new Map(),
    types: new Map<number, DeviceType>([
      [WASHER, DeviceType.Washer],
      [DISHWASHER, DeviceType.Dishwasher],
      [LAMP, DeviceType.Light],
    ]),
    snapshots: {},
    now: T0,
    historyKwh: null,
    historyCalls: 0,
    runs: async () => handle,
    recorder: () => {
      const deps: RunRecorderDeps = {
        runs: handle,
        readSnapshots: async () => {
          if (rig.snapshots instanceof Error) throw rig.snapshots
          return rig.snapshots
        },
        readCapSlice: async (deviceId, capName) => rig.slices.get(`${deviceId}:${capName}`) ?? null,
        deviceTypeOf: async (deviceId) => rig.types.get(deviceId),
        energyFromHistory: async () => {
          rig.historyCalls += 1
          return rig.historyKwh
        },
        emit: (category, run) => rig.events.push({ category, run }),
        logger: recordingLogger(rig.logs),
        clock: () => rig.now,
      }
      return new RunRecorder(deps)
    },
  }
  return rig
}

const running = (on: boolean, since: number, phase: string | null = null): Slice => ({
  running: on,
  since,
  source: 'native',
  phase,
  lastFetchedAt: since,
})

async function allRuns(rig: Rig): Promise<readonly DeviceRun[]> {
  const handle = await rig.runs()
  const page = await handle.query({ deviceId: WASHER, limit: 100 })
  const other = await handle.query({ deviceId: DISHWASHER, limit: 100 })
  return [...page.records, ...other.records].map((r) => r.data)
}

describe('RunRecorder - open and close', () => {
  it('ends with the meter counter at the end minus the counter at the start', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'power-meter', { power: 5, energy: 100.25 }, T0)
    rec.handleState(WASHER, 'running-state', running(true, T0, 'Washing'), T0)
    await rec.idle()
    expect(rec.openRunOf(WASHER)?.detail.energyStartKwh).toBe(100.25)
    rec.handleState(WASHER, 'power-meter', { power: 2000, energy: 100.5 }, T0 + 30 * MIN)
    rec.handleState(WASHER, 'power-meter', { power: 10, energy: 101.09 }, T0 + 52 * MIN)
    rec.handleState(
      WASHER,
      'running-state',
      running(false, T0 + 52 * MIN, 'Finished'),
      T0 + 52 * MIN,
    )
    await rec.idle()
    const [run] = await allRuns(rig)
    expect(run?.state).toBe('closed')
    expect(run?.durationMs).toBe(52 * MIN)
    expect(run?.outcome).toBe('completed')
    expect(run?.detail.energyMethod).toBe('counter-delta')
    expect(run?.detail.energyKwh).toBeCloseTo(0.84, 6)
    expect(run?.detail.peakW).toBe(2000)
    expect(run?.detail.finalPhase).toBe('Finished')
    expect(rig.events.map((e) => e.category)).toEqual(['device-run.opened', 'device-run.closed'])
  })

  it('says null, never 0, when no meter and no history can answer', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'running-state', running(false, T0 + 40 * MIN), T0 + 40 * MIN)
    await rec.idle()
    const [run] = await allRuns(rig)
    expect(run?.detail.energyKwh).toBeNull()
    expect(run?.detail.energyMethod).toBeNull()
    expect(run?.detail.peakW).toBeNull()
  })

  it('falls back to the stored history when the counter fell (a meter reset)', async () => {
    const rig = await makeRig()
    rig.historyKwh = 1.7
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'power-meter', { energy: 500 }, T0)
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'power-meter', { energy: 0.3 }, T0 + 30 * MIN)
    rec.handleState(WASHER, 'running-state', running(false, T0 + 30 * MIN), T0 + 30 * MIN)
    await rec.idle()
    const [run] = await allRuns(rig)
    expect(run?.detail.energyMethod).toBe('history-integral')
    expect(run?.detail.energyKwh).toBe(1.7)
  })

  it('never asks the history for a run shorter than a bucket window', async () => {
    const rig = await makeRig()
    rig.historyKwh = 9
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'running-state', running(false, T0 + 5 * MIN), T0 + 5 * MIN)
    await rec.idle()
    expect(rig.historyCalls).toBe(0)
    expect((await allRuns(rig))[0]?.detail.energyKwh).toBeNull()
  })

  it('records a dwell flap as aborted and a dishwasher fault as error', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'running-state', running(false, T0 + MIN), T0 + MIN)
    rec.handleState(
      DISHWASHER,
      'dishwasher',
      { state: 'error', program: 'Eco50', remaining: 3600 },
      T0,
    )
    rec.handleState(DISHWASHER, 'running-state', running(true, T0), T0)
    rec.handleState(DISHWASHER, 'running-state', running(false, T0 + 30 * MIN), T0 + 30 * MIN)
    await rec.idle()
    const runs = await allRuns(rig)
    expect(runs.find((r) => r.deviceId === WASHER)?.outcome).toBe('aborted')
    const dish = runs.find((r) => r.deviceId === DISHWASHER)
    expect(dish?.outcome).toBe('error')
    expect(dish?.detail.program).toBe('Eco50')
    expect(dish?.detail.remainingAtStartSec).toBe(3600)
  })

  it('ignores a device that is not a washer, dryer or dishwasher', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(LAMP, 'running-state', running(true, T0), T0)
    await rec.idle()
    expect(rec.openRunOf(LAMP)).toBeNull()
    expect(rig.events).toHaveLength(0)
  })

  it('tags every device log line with the numeric deviceId', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'running-state', running(false, T0 + 40 * MIN), T0 + 40 * MIN)
    await rec.idle()
    const deviceLines = rig.logs.filter((l) => l.message.startsWith('device-runs: a run'))
    expect(deviceLines).toHaveLength(2)
    for (const line of deviceLines) expect(line.tags['deviceId']).toBe(WASHER)
  })
})

describe('RunRecorder - restart and boot reconcile', () => {
  it('a run survives a restart: its start counter and program come back from the row', async () => {
    const rig = await makeRig()
    const first = rig.recorder()
    await first.reconcile()
    first.handleState(DISHWASHER, 'dishwasher', { state: 'running', program: 'MARKED-PROGRAM' }, T0)
    first.handleState(DISHWASHER, 'power-meter', { power: 100, energy: 12.5 }, T0)
    first.handleState(DISHWASHER, 'running-state', running(true, T0), T0)
    await first.idle()

    // The provider restarts: a NEW recorder over the same records, a fresh mirror.
    const second = rig.recorder()
    rig.now = T0 + 20 * MIN
    rig.snapshots = {
      [String(DISHWASHER)]: {
        'running-state': running(true, T0),
        'power-meter': { power: 100, energy: 13.0 },
      },
    }
    expect(await second.reconcile()).toBe(true)
    expect(await allRuns(rig)).toHaveLength(1)
    expect(second.openRunOf(DISHWASHER)?.detail.program).toBe('MARKED-PROGRAM')

    second.handleState(DISHWASHER, 'power-meter', { power: 5, energy: 13.4 }, T0 + 60 * MIN)
    second.handleState(DISHWASHER, 'running-state', running(false, T0 + 60 * MIN), T0 + 60 * MIN)
    await second.idle()
    const runs = await allRuns(rig)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe('closed')
    expect(runs[0]?.detail.program).toBe('MARKED-PROGRAM')
    expect(runs[0]?.detail.energyKwh).toBeCloseTo(0.9, 6)
  })

  it('a run open at boot whose device is still running is kept, never duplicated', async () => {
    const rig = await makeRig()
    const first = rig.recorder()
    await first.reconcile()
    first.handleState(WASHER, 'running-state', running(true, T0), T0)
    await first.idle()
    rig.snapshots = { [String(WASHER)]: { 'running-state': running(true, T0) } }
    const second = rig.recorder()
    await second.reconcile()
    await second.reconcile()
    expect(await allRuns(rig)).toHaveLength(1)
    expect(rig.events.filter((e) => e.category === 'device-run.opened')).toHaveLength(1)
  })

  it('a run open at boot whose device stopped meanwhile closes unknown at the device since', async () => {
    const rig = await makeRig()
    const first = rig.recorder()
    await first.reconcile()
    first.handleState(WASHER, 'running-state', running(true, T0), T0)
    await first.idle()
    rig.now = T0 + 3 * 60 * MIN
    rig.snapshots = {
      [String(WASHER)]: { 'running-state': running(false, T0 + 45 * MIN) },
    }
    const second = rig.recorder()
    await second.reconcile()
    const [run] = await allRuns(rig)
    expect(run?.state).toBe('closed')
    expect(run?.outcome).toBe('unknown')
    expect(run?.endSource).toBe('reconcile')
    expect(run?.endedAt).toBe(T0 + 45 * MIN)
    expect(run?.durationMs).toBe(45 * MIN)
  })

  it('a device running with no row opens late from its since, once', async () => {
    const rig = await makeRig()
    rig.now = T0 + 10 * MIN
    rig.snapshots = { [String(WASHER)]: { 'running-state': running(true, T0 + 2 * MIN) } }
    const rec = rig.recorder()
    await rec.reconcile()
    await rec.reconcile()
    const runs = await allRuns(rig)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.startSource).toBe('reconcile')
    expect(runs[0]?.startedAt).toBe(T0 + 2 * MIN)
    expect(runs[0]?.detail.energyStartKwh).toBeNull()
  })

  it('a failed snapshot read changes nothing and a flip that came meanwhile is replayed once', async () => {
    const rig = await makeRig()
    rig.snapshots = new Error('hub unreachable')
    const rec = rig.recorder()
    expect(await rec.reconcile()).toBe(false)
    expect(rec.isLoaded()).toBe(false)
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    await rec.idle()
    expect(await allRuns(rig)).toHaveLength(0)
    rig.snapshots = {}
    expect(await rec.reconcile()).toBe(true)
    await rec.idle()
    expect(await allRuns(rig)).toHaveLength(1)
    expect(
      rig.logs.some((l) => l.level === 'warn' && l.message.includes('reconcile read failed')),
    ).toBe(true)
  })
})

describe('RunRecorder - timer and removal', () => {
  it('the tick retries an unanswered load until it answers', async () => {
    const rig = await makeRig()
    rig.snapshots = new Error('hub unreachable')
    const rec = rig.recorder()
    await rec.tick()
    expect(rec.isLoaded()).toBe(false)
    rig.snapshots = { [String(WASHER)]: { 'running-state': running(true, T0) } }
    await rec.tick()
    expect(rec.isLoaded()).toBe(true)
    expect(rec.openRunOf(WASHER)?.startedAt).toBe(T0)
  })

  it('the tick saves the open power totals so a crash loses the interval, not the run', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    rec.handleState(WASHER, 'running-state', running(true, T0), T0)
    rec.handleState(WASHER, 'power-meter', { power: 400 }, T0 + MIN)
    rec.handleState(WASHER, 'power-meter', { power: 800 }, T0 + 2 * MIN)
    await rec.idle()
    rig.now = T0 + 3 * MIN
    for (let i = 0; i < 5; i += 1) await rec.tick()
    const stored = await (await rig.runs()).get(`${WASHER}:${T0}`)
    expect(stored?.data.detail.peakW).toBe(800)
    expect(stored?.data.detail.avgW).toBeCloseTo((400 * MIN + 800 * MIN) / (2 * MIN), 6)
  })

  it('the removal hook body deletes every run of the device and no other', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    for (const deviceId of [WASHER, DISHWASHER]) {
      rec.handleState(deviceId, 'running-state', running(true, T0), T0)
      rec.handleState(deviceId, 'running-state', running(false, T0 + 40 * MIN), T0 + 40 * MIN)
    }
    await rec.idle()
    const records = createRecordsAccess({
      owner: 'device-history',
      transport: rig.world.transportFor('device-history'),
      secrets: null,
    })
    const counts = await records.deleteDevice(WASHER, { kinds: ['device-runs'] })
    expect(counts['device-runs']).toBe(1)
    const left = await allRuns(rig)
    expect(left.map((r) => r.deviceId)).toEqual([DISHWASHER])
  })
})

describe('device-runs provider', () => {
  it('lists newest first, filters by outcome, and answers the current run from the store', async () => {
    const rig = await makeRig()
    const rec = rig.recorder()
    await rec.reconcile()
    for (const [i, minutes] of [40, 1, 50].entries()) {
      const start = T0 + i * 100 * MIN
      rec.handleState(WASHER, 'running-state', running(true, start), start)
      rec.handleState(
        WASHER,
        'running-state',
        running(false, start + minutes * MIN),
        start + minutes * MIN,
      )
    }
    const openStart = T0 + 400 * MIN
    rec.handleState(WASHER, 'running-state', running(true, openStart), openStart)
    await rec.idle()
    const provider = createDeviceRunsProvider(await rig.runs())
    const all = await provider.listRuns({ deviceId: WASHER, limit: 50 })
    expect(all.runs.map((r) => r.startedAt)).toEqual([
      openStart,
      T0 + 200 * MIN,
      T0 + 100 * MIN,
      T0,
    ])
    const aborted = await provider.listRuns({ deviceId: WASHER, outcome: 'aborted', limit: 50 })
    expect(aborted.runs.map((r) => r.startedAt)).toEqual([T0 + 100 * MIN])
    const paged = await provider.listRuns({ deviceId: WASHER, limit: 2 })
    expect(paged.runs).toHaveLength(2)
    expect(paged.nextCursor).not.toBeNull()
    expect((await provider.getCurrentRun({ deviceId: WASHER }))?.startedAt).toBe(openStart)
    expect(await provider.getCurrentRun({ deviceId: DISHWASHER })).toBeNull()
    expect(await provider.getRun({ deviceId: DISHWASHER, runId: `${WASHER}:${T0}` })).toBeNull()
    expect((await provider.getRun({ deviceId: WASHER, runId: `${WASHER}:${T0}` }))?.state).toBe(
      'closed',
    )
  })
})
