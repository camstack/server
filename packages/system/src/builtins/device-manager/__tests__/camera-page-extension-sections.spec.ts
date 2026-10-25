/**
 * D655 — a camera's device page shows linked devices ONLY through the
 * Extensions widget.
 *
 * The page renders what `deviceManager.getDeviceAggregate` answers, so the
 * gate is on that answer, built by the REAL aggregator over a REAL registry
 * holding the real registrations: device-manager (a system cap) and its
 * `device-extension` owner. Before D655 this camera's aggregate carried a
 * `linked-devices` section (`_linkedDeviceIds`, `_linkedDeviceTrackedIds`)
 * beside the widget; the store holds a value here precisely so the section
 * WOULD appear if its contribution came back.
 */
import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import {
  type AddonContext,
  deviceExtensionCapability,
  deviceManagerCapability,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'
import {
  isDeviceExtensionProvider,
  isDeviceManagerProvider,
  makeAddonContext,
  providerOf,
  registrationsOf,
} from './typed-addon-context.js'

const CAMERA = 101
const SOURCE = 700

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function memorySettings(
  seed: Record<number, Record<string, unknown>>,
): NonNullable<AddonContext['settings']> {
  const addonStore: Record<string, unknown> = {}
  const deviceStores = new Map<number, Record<string, unknown>>(
    Object.entries(seed).map(([id, blob]) => [Number(id), { ...blob }]),
  )
  return {
    readAddonStore: async () => ({ ...addonStore }),
    writeAddonStore: async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    },
    readDeviceStoreBatch: async (ids: readonly number[]) =>
      new Map(ids.map((id) => [id, { ...deviceStores.get(id) }])),
    listDeviceStoreIds: async () => [...deviceStores.keys()],
    readDeviceStore: async (id: number) => ({ ...deviceStores.get(id) }),
    writeDeviceStore: async (id: number, data: Record<string, unknown>) => {
      deviceStores.set(id, { ...data })
    },
    clearDeviceStore: async () => undefined,
    readDeviceRuntimeState: async () => ({}),
    writeDeviceRuntimeState: async () => undefined,
    clearDeviceRuntimeState: async () => undefined,
    getSection: async () => ({}),
    setSection: async () => undefined,
  }
}

/** Every configured store holds a value, so an old section would have one to show. */
const STORES = {
  [CAMERA]: {
    _linkedDeviceIds: [SOURCE],
    _linkedDeviceTrackedIds: [SOURCE],
  },
}

interface FieldView {
  readonly sectionId: string
  readonly key: string | null
}

async function cameraPageFields(): Promise<readonly FieldView[]> {
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(deviceManagerCapability)
  registry.declareCapability(deviceExtensionCapability)

  const store = await makeSettingsStoreApi()
  await seedDeviceRow(store, { deviceId: CAMERA, type: 'camera' })
  await seedDeviceRow(store, { deviceId: SOURCE, type: 'sensor' })

  const records = await makeRecordsAccessForOwner('device-manager')
  const manager = new DeviceManagerAddon()
  const managerRegs = registrationsOf(
    await manager.initialize(
      makeAddonContext({
        id: 'device-manager',
        logger,
        settings: memorySettings(STORES),
        records,
        api: { settingsStore: store.api },
        kernel: { deviceRegistry: new DeviceRegistry(), capabilityRegistry: registry },
      }),
    ),
  )
  const managerProvider = providerOf(managerRegs, 'device-manager', isDeviceManagerProvider)
  registry.registerProvider('device-manager', 'device-manager', managerProvider)
  registry.registerProvider(
    'device-extension',
    'device-manager',
    providerOf(managerRegs, 'device-extension', isDeviceExtensionProvider),
  )
  registry.ready()
  const { settings } = await managerProvider.getDeviceAggregate({ deviceId: CAMERA })
  return (settings?.sections ?? []).flatMap((section) =>
    section.fields.map((field) => ({
      sectionId: section.id,
      key: 'key' in field && typeof field.key === 'string' ? field.key : null,
    })),
  )
}

describe('the camera page shows linked devices only as Extensions (D655)', () => {
  it('no old section and no old field on the camera aggregate', async () => {
    const fields = await cameraPageFields()
    const sectionIds = new Set(fields.map((f) => f.sectionId))
    expect(sectionIds.has('linked-devices')).toBe(false)
    const keys = fields.map((f) => f.key)
    expect(keys).not.toContain('_linkedDeviceIds')
    expect(keys).not.toContain('_linkedDeviceTrackedIds')
  })

  it('the Extensions widget is still there', async () => {
    const fields = await cameraPageFields()
    expect(fields).toContainEqual({
      sectionId: 'device-extension-widget',
      key: 'device-extensionWidget',
    })
  })
})
