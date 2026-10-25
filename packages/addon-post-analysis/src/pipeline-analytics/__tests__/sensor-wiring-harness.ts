/**
 * A BOOTED pipeline-analytics addon on a real (fake) bus, for the specs that
 * drive `handleSensorStateChanged` end to end: a `DeviceStateChanged` in, rows,
 * markers and notification-centre hand-offs out.
 */

import { makeFakeRecords } from './fake-records.js'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  type FakeDeviceManager,
  type FakeEventBus,
  type FakeLinkedDevice,
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from './test-helpers.js'

export const SENSOR_WIRING_CAMERA_ID = 101
export const SENSOR_WIRING_SENSOR_ID = 4131

/** camera id → the devices it links. */
export type SensorWiringLinks = ReadonlyArray<readonly [number, readonly FakeLinkedDevice[]]>

/** Camera 101 links contact sensor 4131, opted into tracked events. */
export const DEFAULT_SENSOR_WIRING_LINKS: SensorWiringLinks = [
  [SENSOR_WIRING_CAMERA_ID, [{ deviceId: SENSOR_WIRING_SENSOR_ID, name: 'Contatto porta' }]],
]

export interface FakeSnapshotResult {
  readonly base64: string
  readonly contentType: string
}

export const FAKE_SNAPSHOT: FakeSnapshotResult = {
  base64: Buffer.from('jpeg-bytes').toString('base64'),
  contentType: 'image/jpeg',
}

export interface FakeSnapshotCap {
  readonly getSnapshot: {
    readonly query: (input: {
      deviceId: number
      force?: boolean
    }) => Promise<FakeSnapshotResult | null>
  }
}

export interface SensorWiringOptions {
  readonly logger?: IScopedLogger
  readonly links?: SensorWiringLinks
  readonly snapshot?: FakeSnapshotCap
}

export interface SensorWiringBooted {
  readonly addon: PipelineAnalyticsAddon
  readonly bus: FakeEventBus
  readonly deviceManager: FakeDeviceManager
}

/** Let the bus handler (dispatched under `void`) run its awaits. */
export async function flushSensorWiring(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

export async function bootSensorWiring(
  options: SensorWiringOptions = {},
): Promise<SensorWiringBooted> {
  const logger = options.logger ?? makeSilentLogger()
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  // The cameras and the sensors linked to them — what the reverse index is
  // built from. Without a link every event resolves to `no-camera` and a test
  // could not tell the gate from the camera derivation.
  for (const [cameraId, devices] of options.links ?? DEFAULT_SENSOR_WIRING_LINKS) {
    deviceManager.setLinkedCamera(cameraId, devices)
  }
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    snapshot: options.snapshot ?? { getSnapshot: { query: async () => FAKE_SNAPSHOT } },
  })
  const addonStore: Record<string, unknown> = { postProcessingNodeId: 'hub' }
  const deviceStore = new Map<number, Record<string, unknown>>()

  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    records: makeFakeRecords().records,
    logger,
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
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
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
      throw new Error('no native providers here')
    },
    fetchDevice: async () => {
      throw new Error('no devices here')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return { addon, bus, deviceManager }
}
