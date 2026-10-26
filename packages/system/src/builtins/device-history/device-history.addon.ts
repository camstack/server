/**
 * device-history — the ONE mechanism for numeric history (D850). Hub-only, its
 * own runner (not grouped, D29): it writes through the settings door into
 * `history.db`, a file with its own serving thread (D851), so a slow rollup can
 * never queue behind — or in front of — configuration reads.
 *
 * This shell only wires: the capability provider, the bus subscription, the
 * timers and the retention settings. The engine is {@link HistoryRuntime}.
 *
 * Boot waits for `onHubReachable` — the settings door and the device manager
 * are hub capabilities, and a forked runner cannot call them from
 * `onInitialize`. Until then the provider answers "starting" rather than an
 * empty history (an unanswered query is not an empty one, D315).
 *
 * Readiness follows the STORE, not the registration: the provider registers at
 * `onInitialize`, but `ready` is emitted only once the runtime is open in
 * `onHubReachable` (`autoEmitReadiness` is off). Producers declare their
 * series on `ready`; the automatic emit at registration sent every one of
 * them into "device-history is starting" on each boot (`.50`, 1.2.607:
 * metrics-native and pipeline-analytics).
 */
import {
  armRemovalReconcile,
  BaseAddon,
  type ConfigUISchema,
  type DeviceType,
  deviceHistoryCapability,
  deviceRemovalHookCapability,
  EventCategory,
  emitReadiness,
  HISTORY_CATALOG,
  HISTORY_ITEM_CATALOG,
  type IDeviceHistoryProvider,
  isReadingQuantity,
  type IDeviceRemovalHookProvider,
  type ProviderRegistration,
} from '@camstack/types'
import type { SnapshotMap } from './capture/capture-engine.js'
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention/retention.js'
import { HistoryRuntime } from './runtime/history-runtime.js'
import { UNRAID_ADDON_ID, type LegacyScale, unraidInformationScale } from './store/series-scale.js'

export interface DeviceHistoryConfig extends Record<string, unknown> {
  rawDays: number
  fiveMinuteDays: number
  hourDays: number
  /** `0` keeps the daily tier forever. */
  dayDays: number
}

const DEFAULT_CONFIG: DeviceHistoryConfig = {
  rawDays: DEFAULT_RETENTION.rawDays,
  fiveMinuteDays: DEFAULT_RETENTION.fiveMinuteDays,
  hourDays: DEFAULT_RETENTION.hourDays,
  dayDays: 0,
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The caller the transport stamped (never in an input schema); `null` when unstamped. */
export function callerOf(input: unknown): string | null {
  if (!isRecord(input)) return null
  const raw = input['callerAddonId']
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export class DeviceHistoryAddon extends BaseAddon<DeviceHistoryConfig> {
  private runtime: HistoryRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private removalHook: IDeviceRemovalHookProvider | null = null

  /** This instance's readiness generation (the base class keeps its own private). */
  private readonly readinessGeneration: string = `device-history-${Date.now().toString(36)}`

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  /** `ready` is the store being open, emitted by {@link emitStoreReadiness}. */
  protected override get autoEmitReadiness(): boolean {
    return false
  }

  /** Readiness of both provided caps, on the bare node this runner belongs to. */
  private emitStoreReadiness(state: 'starting' | 'ready' | 'down'): void {
    const ctx = this.ctxIfReady
    if (ctx === null) return
    const raw = ctx.kernel?.localNodeId ?? 'hub'
    const nodeId = raw.includes('/') ? (raw.split('/')[0] ?? raw) : raw
    for (const capName of [deviceHistoryCapability.name, deviceRemovalHookCapability.name]) {
      try {
        emitReadiness(ctx.eventBus, {
          capName,
          scope: { type: 'node', nodeId },
          state,
          generation: this.readinessGeneration,
          sourceNodeId: nodeId,
        })
      } catch (err: unknown) {
        ctx.logger.warn('device-history: readiness not emitted', {
          meta: { capName, state, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  private retention(): RetentionPolicy {
    const c = this.config
    return {
      rawDays: positiveOr(c.rawDays, DEFAULT_RETENTION.rawDays),
      fiveMinuteDays: positiveOr(c.fiveMinuteDays, DEFAULT_RETENTION.fiveMinuteDays),
      hourDays: positiveOr(c.hourDays, DEFAULT_RETENTION.hourDays),
      dayDays: positiveOr(c.dayDays, 0) > 0 ? c.dayDays : null,
    }
  }

  /** Unraid array counters still stored in GiB. A failed listing throws to the caller. */
  private async legacyScales(): Promise<readonly LegacyScale[]> {
    const devices = await this.ctx.api.deviceManager.listAll.query({})
    const scales: LegacyScale[] = []
    for (const device of devices) {
      if (device.addonId !== UNRAID_ADDON_ID) continue
      const entityKey = device.config['entityKey']
      if (typeof entityKey !== 'string') continue
      const scale = unraidInformationScale(device.id, entityKey)
      if (scale !== null) scales.push(scale)
    }
    return scales
  }

  private requireRuntime(): HistoryRuntime {
    if (this.runtime === null) {
      throw new Error('device-history is starting — the history store is not open yet')
    }
    return this.runtime
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const provider: IDeviceHistoryProvider = {
      listSeries: async (input) =>
        this.requireRuntime().query.listSeries({ kind: 'device', deviceId: input.deviceId }),
      listNodeSeries: async (input) =>
        this.requireRuntime().query.listSeries({ kind: 'node', nodeId: input.forNodeId }),
      query: async ({ deviceId, ...window }) =>
        this.requireRuntime().query.query({ ...window, subject: { kind: 'device', deviceId } }),
      queryNode: async ({ forNodeId, ...window }) =>
        this.requireRuntime().query.query({
          ...window,
          subject: { kind: 'node', nodeId: forNodeId },
        }),
      queryMany: async (input) => ({ results: await this.requireRuntime().query.queryMany(input) }),
      declareSeries: async (input) =>
        this.requireRuntime().ingest.declareSeries(callerOf(input), input),
      record: async (input) => this.requireRuntime().ingest.record(callerOf(input), input.points),
      recordBuckets: async (input) =>
        this.requireRuntime().ingest.recordBuckets(callerOf(input), input.buckets),
      getDeviceEnabled: async (input) => ({
        enabled: this.requireRuntime().isEnabled(input.deviceId),
      }),
      setDeviceEnabled: async (input) => ({
        enabled: await this.requireRuntime().setEnabled(input.deviceId, input.enabled),
      }),
      getStatus: async () => this.requireRuntime().status(),
      listOrphanSeries: async () => this.requireRuntime().listOrphans(),
      deleteOrphanSeries: async (input) => ({
        results: await this.requireRuntime().deleteOrphans(input.seriesIds),
      }),
    }
    this.emitStoreReadiness('starting')
    this.ctx.logger.info(
      'Initialized — device-history provider registered (store opens on hub link)',
    )
    const removalHook: IDeviceRemovalHookProvider = {
      onDeviceRemoved: async (input) => {
        const { series } = await this.requireRuntime().removeDevice(input.deviceId)
        if (series > 0) {
          this.ctx.logger.info('device-history: removed the history of a deleted device', {
            tags: { deviceId: input.deviceId },
            meta: { counts: { series }, deletedAt: input.deletedAt },
          })
        }
        return { counts: { series } }
      },
      listDeviceData: async () =>
        [...this.requireRuntime().seriesByDevice()].map(([deviceId, count]) => ({
          store: 'series',
          deviceId,
          count,
        })),
    }
    this.removalHook = removalHook
    return [
      { capability: deviceHistoryCapability, provider },
      { capability: deviceRemovalHookCapability, provider: removalHook },
    ]
  }

  override async onHubReachable(): Promise<void> {
    const api = this.ctx.api
    const runtime = new HistoryRuntime({
      door: api.settingsStore,
      catalog: HISTORY_CATALOG,
      itemCatalog: HISTORY_ITEM_CATALOG,
      deviceSource: {
        listAll: async () => {
          const devices = await api.deviceManager.listAll.query({ projection: 'slim' })
          return devices.map((d): { id: number; type: DeviceType } => ({ id: d.id, type: d.type }))
        },
        getDevice: async (deviceId) => {
          const d = await api.deviceManager.getDevice.query({ deviceId })
          return d === null ? null : { id: d.id, type: d.type }
        },
      },
      readSnapshots: async (): Promise<SnapshotMap> => api.deviceState.getAllSnapshots.query({}),
      readCapSlice: (deviceId, capName) => api.deviceState.getCapSlice.query({ deviceId, capName }),
      readDeviceQuantity: async (deviceId) => {
        const device = await api.deviceManager.getDevice.query({ deviceId })
        const quantity = device?.sourceInfo?.quantity
        return isReadingQuantity(quantity) ? quantity : null
      },
      listLegacyScales: () => this.legacyScales(),
      retention: () => this.retention(),
      logger: this.ctx.logger,
      clock: () => Date.now(),
    })
    await runtime.prepare()
    this.unsubscribe = this.ctx.eventBus.subscribe(
      { category: EventCategory.DeviceStateChanged },
      (event) => {
        const data = event.data
        if (!isRecord(data)) return
        const { deviceId, capName, slice } = data
        if (typeof deviceId !== 'number' || typeof capName !== 'string' || !isRecord(slice)) return
        const at = event.timestamp instanceof Date ? event.timestamp.getTime() : Date.now()
        runtime.capture.handleState(deviceId, capName, slice, at)
      },
    )
    this.ctx.addDisposer(async () => this.stopRuntime())
    this.runtime = runtime
    await runtime.finishBoot()
    runtime.startTimers()
    // Catch up on deletions missed while this addon was down (D865) — from
    // device-manager's tombstones, never from a device being absent.
    const removalHook = this.removalHook
    if (removalHook !== null) {
      this.ctx.addDisposer(
        armRemovalReconcile({
          api: this.ctx.api,
          logger: this.ctx.logger,
          remove: (input) => removalHook.onDeviceRemoved(input),
        }),
      )
    }
    this.emitStoreReadiness('ready')
    this.ctx.logger.info('device-history: capturing', {
      meta: { series: runtime.status().series, metrics: runtime.status().metrics },
    })
  }

  private async stopRuntime(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.runtime?.stop()
  }

  protected override async onShutdown(): Promise<void> {
    this.emitStoreReadiness('down')
    await this.stopRuntime()
    this.runtime = null
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'retention',
          title: 'Retention',
          description:
            'How long each tier is kept. The raw points feed the 5-minute rollup; the 1-day tier is kept forever unless a number of days is set.',
          columns: 2,
          fields: [
            {
              type: 'number',
              key: 'rawDays',
              label: 'Raw points (days)',
              min: 1,
              max: 60,
              step: 1,
            },
            {
              type: 'number',
              key: 'fiveMinuteDays',
              label: '5-minute rollup (days)',
              min: 1,
              max: 365,
              step: 1,
            },
            {
              type: 'number',
              key: 'hourDays',
              label: '1-hour rollup (days)',
              min: 7,
              max: 3650,
              step: 1,
            },
            {
              type: 'number',
              key: 'dayDays',
              label: '1-day rollup (days, 0 = forever)',
              min: 0,
              max: 36500,
              step: 1,
            },
          ],
        },
      ],
    })
  }
}

export default DeviceHistoryAddon
