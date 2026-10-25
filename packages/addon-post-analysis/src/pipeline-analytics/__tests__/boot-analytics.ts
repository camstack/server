/**
 * Boot the REAL `pipeline-analytics` addon against fakes, and record every log
 * line it emits.
 *
 * Extracted from `key-frame-retry-e2e.spec.ts` when a second end-to-end spec
 * needed the same harness. Both defects it exists for were WIRING defects — a
 * correct decision function nobody consulted, and a store method nobody called —
 * and neither is visible to a unit test of the piece in isolation. Reproducing
 * this fixture per spec would eventually let the two drift, which is the same
 * failure one level up.
 */
import type {
  AddonContext,
  AddonInitResult,
  IScopedLogger,
  SettingsStoreClient,
} from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  type FakeDeviceManager,
  type FakeEventBus,
  type FakeIntegrationsNamespace,
  type FakeNativeCropReply,
  type FakeNativeCropRequest,
  type FakeParcelRead,
  type FakeParkRequest,
  type FakePipelineExecutor,
  type FakePipelineRunnerOptions,
  type FakeSettingsStore,
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakePipelineRunner,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  tracklessEventRows,
} from './test-helpers.js'
import { makeAnalyticsRecords, type FakeRecords } from './fake-records.js'

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

export interface Booted {
  readonly addon: PipelineAnalyticsAddon
  readonly bus: FakeEventBus
  readonly requests: FakeNativeCropRequest[]
  /** Every PARK order the addon sent (D422), and every parcel read it made. */
  readonly parks: FakeParkRequest[]
  readonly parcelReads: FakeParcelRead[]
  readonly logs: LogLine[]
  /** The store every `declare`d collection landed in — read it to assert what
   *  the addon actually PERSISTED, rather than what it merely announced. */
  readonly settings: FakeSettingsStore
  /** Hub boot writes trackless events here (phase 5). */
  readonly records: FakeRecords
  /** What `initialize` returned — the providers and action handlers the
   *  kernel would register, so a spec can drive the REAL wiring. */
  readonly init: AddonInitResult | undefined
}

/** Persisted rows for motion / audio / sensor (`ctx.records`, every node). */
export function bootedEventRows(
  booted: Booted,
  collection: string,
): readonly Record<string, unknown>[] {
  return tracklessEventRows({
    records: booted.records,
    collection,
  })
}

/** A logger that records every line, so the drop branches are assertable from
 *  outside the addon — the whole point of fix 1a. */
export function makeRecordingLogger(logs: LogLine[]): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, extras?: unknown): void => {
      logs.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Extra wiring a single spec needs. Every field is optional — the default is
 *  the harness every other spec already boots against. */
export interface BootAnalyticsOptions {
  /** The `integrations` namespace `DeclaredDevices` reaches for. Omitted ⇒
   *  absent, which rejects immediately. */
  readonly integrations?: FakeIntegrationsNamespace
  /**
   * Wrap the fake settings-store client before the addon sees it.
   *
   * The one thing a boot-timing spec has to be able to do: make a specific
   * collection's read SLOW. Every durable back-fill in this addon is a query
   * over the store, and "does `initialize()` still return" is only answerable
   * if one of them can be held open.
   */
  readonly wrapSettingsStore?: (client: SettingsStoreClient) => SettingsStoreClient
  /**
   * Per-device settings blob, as `ctx.settings.readDeviceStore` would return
   * it. This is the ONLY way a spec can flip a per-camera knob — every
   * `resolve*Settings` in the addon reads that store, not the settings-store
   * collections.
   */
  readonly deviceSettings?: Record<string, unknown>
  /** An executor for the confirmation gate's re-detection. Omitted ⇒ absent. */
  readonly pipelineExecutor?: FakePipelineExecutor
  /** How the fake node answers PARK orders and parcel reads (D422). */
  readonly parking?: FakePipelineRunnerOptions
  /** `deviceManager.listDeviceIdsByCaps`. Omitted ⇒ absent from the fake. */
  readonly listDeviceIdsByCaps?: (capNames: readonly string[]) => Promise<readonly number[]>
  /** `api.notificationOutput`: the target catalog a rule save checks its targets against. */
  readonly notificationOutput?: unknown
}

export async function bootAnalytics(
  deviceId: number,
  respond: (request: FakeNativeCropRequest) => Promise<FakeNativeCropReply | null>,
  options: BootAnalyticsOptions = {},
): Promise<Booted> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  deviceManager.setActive(deviceId, 'pipeline-analytics', true)
  const { runner, requests, parks, parcelReads } = makeFakePipelineRunner(
    respond,
    options.parking ?? {},
  )

  const api = makeFakeAddonApi({
    settingsStore: options.wrapSettingsStore?.(settings.client) ?? settings.client,
    deviceManager:
      options.listDeviceIdsByCaps !== undefined
        ? withListDeviceIdsByCaps(deviceManager.api.deviceManager, options.listDeviceIdsByCaps)
        : deviceManager.api.deviceManager,
    pipelineRunner: runner,
    ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
    ...(options.notificationOutput !== undefined
      ? { notificationOutput: options.notificationOutput }
      : {}),
    ...(options.pipelineExecutor !== undefined
      ? { pipelineExecutor: options.pipelineExecutor }
      : {}),
  })
  const logs: LogLine[] = []
  const logger: IScopedLogger = makeRecordingLogger(logs)
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()
  if (options.deviceSettings !== undefined) {
    deviceStore.set(deviceId, { ...options.deviceSettings })
  }

  const recordsWorld = await makeAnalyticsRecords()
  const records = recordsWorld.records
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no')
        },
        create: async () => {
          throw new Error('no')
        },
        createContext: () => {
          throw new Error('no')
        },
        register: async () => {
          throw new Error('no')
        },
        remove: async () => {
          /* no-op */
        },
        decommission: async () => {
          /* no-op */
        },
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(id: number) {
        return { ...deviceStore.get(id) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
    },
    getNativeProvider: () => {
      throw new Error('no native providers in e2e')
    },
    fetchDevice: async () => {
      throw new Error('no devices in e2e')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  const init = (await addon.initialize(ctx)) ?? undefined
  return { addon, bus, requests, parks, parcelReads, logs, settings, records: recordsWorld, init }
}

/** The fake device manager, plus the one targeted cap query a spec answers. */
function withListDeviceIdsByCaps(
  base: FakeDeviceManager['api']['deviceManager'],
  answer: (capNames: readonly string[]) => Promise<readonly number[]>,
): FakeDeviceManager['api']['deviceManager'] {
  return {
    ...base,
    listDeviceIdsByCaps: {
      query: async (input: { capNames: string[] }) => [...(await answer(input.capNames))],
    },
  } as unknown as FakeDeviceManager['api']['deviceManager']
}
