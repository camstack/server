/**
 * A whole device-history runtime over a REAL `history.db` in a temp dir, with a
 * clock the spec moves and a device directory it controls. Nothing here is a
 * fake of the code under test: only the hub (device list, state snapshots) and
 * time are stand-ins.
 */
import {
  DeviceType,
  HISTORY_CATALOG,
  HISTORY_ITEM_CATALOG,
  type ReadingQuantity,
} from '@camstack/types'
import type {
  HistoryCatalog,
  HistoryItemCatalog,
  SnapshotMap,
} from '../../capture/capture-engine.js'
import { HistoryRuntime } from '../../runtime/history-runtime.js'
import { DEFAULT_RETENTION, type RetentionPolicy } from '../../retention/retention.js'
import { type CapturedLog, type RealDoor, openRealDoor, recordingLogger } from './real-door.js'

/** 2026-10-14 10:00:00 UTC — aligned to every UTC tier. */
export const T0 = Date.UTC(2026, 9, 14, 10, 0, 0)

export interface Harness {
  readonly runtime: HistoryRuntime
  readonly rd: RealDoor
  readonly logs: CapturedLog[]
  /** Device id to type; mutate to change what the hub "says". */
  readonly devices: Map<number, DeviceType>
  readonly slices: Map<string, Readonly<Record<string, unknown>>>
  readonly quantities: Map<number, ReadingQuantity>
  /** What `getAllSnapshots` answers; an Error makes the read FAIL. */
  setSnapshots(value: SnapshotMap | Error): void
  now(): number
  advance(ms: number): void
  setNow(ms: number): void
  /** Stop the runtime and open a NEW one over the same `history.db` (a process restart). */
  restart(): Promise<void>
  /** Emit pending points, flush the buffer, tick the rollups once. */
  settle(): Promise<void>
  close(): Promise<void>
}

export interface HarnessOptions {
  readonly catalog?: HistoryCatalog
  readonly itemCatalog?: HistoryItemCatalog
  readonly devices?: Readonly<Record<number, DeviceType>>
  readonly start?: number
  readonly retention?: RetentionPolicy
  readonly boot?: boolean
  /** What `getAllSnapshots` answers at boot; an Error makes the read fail. */
  readonly snapshots?: SnapshotMap | Error
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const rd = await openRealDoor()
  const logs: CapturedLog[] = []
  const devices = new Map<number, DeviceType>(
    Object.entries(options.devices ?? {}).map(([id, type]) => [Number(id), type]),
  )
  const slices = new Map<string, Readonly<Record<string, unknown>>>()
  const quantities = new Map<number, ReadingQuantity>()
  const state: { clock: number; snapshots: SnapshotMap | Error } = {
    clock: options.start ?? T0,
    snapshots: options.snapshots ?? {},
  }
  const makeRuntime = (): HistoryRuntime =>
    new HistoryRuntime({
      door: rd.door,
      catalog: options.catalog ?? HISTORY_CATALOG,
      itemCatalog: options.itemCatalog ?? HISTORY_ITEM_CATALOG,
      deviceSource: {
        listAll: async () => [...devices].map(([id, type]) => ({ id, type })),
        getDevice: async (deviceId) => {
          const type = devices.get(deviceId)
          return type === undefined ? null : { id: deviceId, type }
        },
      },
      readSnapshots: async () => {
        if (state.snapshots instanceof Error) throw state.snapshots
        return state.snapshots
      },
      readCapSlice: async (deviceId, capName) => slices.get(`${deviceId}:${capName}`) ?? null,
      readDeviceQuantity: async (deviceId) => quantities.get(deviceId) ?? null,
      retention: () => options.retention ?? DEFAULT_RETENTION,
      logger: recordingLogger(logs),
      clock: () => state.clock,
    })
  let current = makeRuntime()
  if (options.boot !== false) {
    await current.prepare()
    await current.finishBoot()
  }
  return {
    get runtime() {
      return current
    },
    restart: async () => {
      await current.stop()
      current = makeRuntime()
      await current.prepare()
      await current.finishBoot()
    },
    rd,
    logs,
    devices,
    slices,
    quantities,
    setSnapshots: (value) => {
      state.snapshots = value
    },
    now: () => state.clock,
    advance: (ms) => {
      state.clock += ms
    },
    setNow: (ms) => {
      state.clock = ms
    },
    settle: async () => {
      await current.flushNow()
      await current.rollup.tick()
    },
    close: async () => {
      await current.stop()
      await rd.close()
    },
  }
}
