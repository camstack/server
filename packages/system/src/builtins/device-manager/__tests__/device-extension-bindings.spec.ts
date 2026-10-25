/**
 * D648 — a camera's `device-extension` OWNERS are its bindings, derived by the
 * REAL `getBindings` (step 0, `collectionBindings`) from a REAL registry that
 * holds the real registration: device-manager's, the owner of `linked-devices`.
 *
 * Nothing here supplies a binding. The dispatcher spec pins what happens once
 * the owners are known (including a fan-out over several); this pins that they
 * ARE known — a camera gets its owner, and a device no slot is offered on (a
 * sensor) gets none, because the cap's `deviceTypes` is the codegen'd union of
 * the slots' host types.
 */
import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import { type AddonContext, deviceExtensionCapability, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'
import {
  isDeviceExtensionProvider,
  makeAddonContext,
  providerOf,
  registrationsOf,
} from './typed-addon-context.js'

const CAMERA = 101
const SENSOR = 700

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
  addonStore: Record<string, unknown> = {},
): NonNullable<AddonContext['settings']> {
  const deviceStores = new Map<number, Record<string, unknown>>()
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

async function ownersOf(
  deviceId: number,
  storedBindings?: Record<string, unknown>,
  /** `false`: no provider of the cap is registered (a boot window, every provider down). */
  providerLive = true,
): Promise<readonly string[]> {
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(deviceExtensionCapability)

  const store = await makeSettingsStoreApi()
  await seedDeviceRow(store, { deviceId: CAMERA, type: 'camera' })
  await seedDeviceRow(store, { deviceId: SENSOR, type: 'sensor' })

  const records = await makeRecordsAccessForOwner('device-manager')
  const manager = new DeviceManagerAddon()
  const managerRegs = registrationsOf(
    await manager.initialize(
      makeAddonContext({
        id: 'device-manager',
        logger,
        settings: memorySettings(
          storedBindings === undefined ? {} : { deviceBindings: storedBindings },
        ),
        records,
        api: { settingsStore: store.api },
        kernel: { deviceRegistry: new DeviceRegistry(), capabilityRegistry: registry },
      }),
    ),
  )
  if (providerLive) {
    registry.registerProvider(
      'device-extension',
      'device-manager',
      providerOf(managerRegs, 'device-extension', isDeviceExtensionProvider),
    )
  }
  registry.ready()

  const { entries } = await manager.getBindings({ deviceId })
  return entries.filter((e) => e.capName === 'device-extension').map((e) => e.providerAddonId)
}

describe('device-extension owners are derived bindings (D648, D554 step 0)', () => {
  it('a camera is bound to its slot owner', async () => {
    expect(await ownersOf(CAMERA)).toEqual(['device-manager'])
  })

  it('a STORED activation row on the collection cap (a retired wrapper`s leftover) adds no second owner', async () => {
    // Camera 101 on the live hub, 2026-10-02: `deviceBindings['101']['device-extension']`
    // still names the retired `virtual-doorbell`. A collection cap persists
    // nothing (D556): its owners are step 0's derived set, and only that.
    expect(
      await ownersOf(CAMERA, {
        [String(CAMERA)]: { 'device-extension': { wrapperAddonId: 'virtual-doorbell' } },
      }),
    ).toEqual(['device-manager'])
  })

  it('…and with NO provider of the cap live (a boot window), the row is still no owner (R1-L1)', async () => {
    expect(
      await ownersOf(
        CAMERA,
        { [String(CAMERA)]: { 'device-extension': { wrapperAddonId: 'virtual-doorbell' } } },
        false,
      ),
    ).toEqual([])
  })

  it('a sensor — no slot is offered on it — is bound to none', async () => {
    expect(await ownersOf(SENSOR)).toEqual([])
  })
})
