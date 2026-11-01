/**
 * The run ledger as the addon shell sees it: the declared kind, the recorder,
 * the capability provider, the timer and the device-removal hook body (D865).
 * The shell only forwards (`onHubReachable` -> {@link DeviceRunsService.open},
 * the bus -> {@link DeviceRunsService.handleState}); everything with a rule is
 * in the files beside this one.
 */
import {
  type DeviceRun,
  type DeviceType,
  type EventCategory,
  type IDeviceRunsProvider,
  type IScopedLogger,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import type { SnapshotMap } from '../capture/capture-engine.js'
import { createDeviceRunsProvider } from './device-runs-provider.js'
import { deviceRunsRecordKinds } from './device-runs-record-kinds.js'
import { RECORDER_TICK_MS, RunRecorder } from './run-recorder.js'
import type { Slice } from './slice-readers.js'

export interface DeviceRunsServiceDeps {
  readonly records: RecordsAccess
  readonly readSnapshots: () => Promise<SnapshotMap>
  readonly readCapSlice: (deviceId: number, capName: string) => Promise<Slice | null>
  readonly deviceTypeOf: (deviceId: number) => Promise<DeviceType | undefined>
  readonly energyFromHistory: (deviceId: number, from: number, to: number) => Promise<number | null>
  readonly emit: (category: EventCategory, run: DeviceRun) => void
  readonly logger: IScopedLogger
  readonly clock: () => number
}

export class DeviceRunsService {
  private recorder: RunRecorder | null = null
  private handle: RecordKindHandle<DeviceRun> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private provider: IDeviceRunsProvider | null = null

  constructor(private readonly deps: DeviceRunsServiceDeps) {}

  /** Declare the kind, then the first reconcile; an unanswered one is retried by the timer. */
  async open(): Promise<{ readonly provider: IDeviceRunsProvider }> {
    await this.deps.records.declare(deviceRunsRecordKinds)
    const handle = this.deps.records.kind(deviceRunsRecordKinds['device-runs'])
    this.handle = handle
    const recorder = new RunRecorder({ ...this.deps, runs: handle })
    this.recorder = recorder
    this.provider = createDeviceRunsProvider(handle)
    await recorder.reconcile()
    return { provider: this.provider }
  }

  startTimer(): void {
    const recorder = this.recorder
    if (recorder === null || this.timer !== null) return
    const timer = setInterval(() => {
      void recorder.tick().catch((err: unknown) => {
        this.deps.logger.warn('device-runs: scheduled pass threw', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, RECORDER_TICK_MS)
    timer.unref()
    this.timer = timer
  }

  handleState(deviceId: number, capName: string, slice: Slice, at: number): void {
    this.recorder?.handleState(deviceId, capName, slice, at)
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const recorder = this.recorder
    if (recorder === null) return
    await recorder.idle()
    await recorder.flushOpen()
  }

  /** The D865 hook body: how many run rows the removal deleted. */
  async removeDevice(deviceId: number): Promise<number> {
    const counts = await this.deps.records.deleteDevice(deviceId, { kinds: ['device-runs'] })
    return counts['device-runs'] ?? 0
  }

  /** Run rows per device, for the admin clean-up listing. */
  async countByDevice(): Promise<readonly { deviceId: number; count: number }[]> {
    const handle = this.handle
    if (handle === null) return []
    const rows = await handle.aggregate({ op: 'count', groupBy: 'deviceId' })
    const out: { deviceId: number; count: number }[] = []
    for (const row of rows) {
      if (typeof row.group === 'number' && row.value !== null) {
        out.push({ deviceId: row.group, count: row.value })
      }
    }
    return out
  }
}
