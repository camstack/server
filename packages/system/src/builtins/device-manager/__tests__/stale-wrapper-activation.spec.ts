/**
 * Task 17 review M1 — a stored wrapper activation that names a cap which no
 * longer HAS a wrapper (the retired `virtual-doorbell` on `doorbell`, slice 6,
 * D671) is said by name and never hides the native.
 *
 * Before: step 1 of `getBindings` turned any persisted `wrapperAddonId` string
 * into a `wrapped` entry, so a camera whose migration had not settled kept
 * `{ doorbell, wrapped, virtual-doorbell }` — the composer's native entry was
 * shadowed, every call was routed to an addon that no longer exists, HA / HAP /
 * Alexa kept advertising the doorbell, and not one line said so (D391).
 *
 * Now the cap's DECLARED definition (static, never the live registry — a
 * wrapper runner still starting must not read as stale) decides: a string
 * `wrapperAddonId` on a cap that is not `kind: 'wrapper'` is treated as absent,
 * the native resolves as if the row were not there, and one WARN per
 * (device, cap) per process names the row and the recovery call. Nothing is
 * written: the row stays until the operator clears it (spec S1).
 */
import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import type { DeviceBindingsStore } from '../device-meta-types.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { StaleWrapperActivations } from '../stale-wrapper-activations.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'
import { makeAddonContext } from './typed-addon-context.js'

const CAMERA = 101
const OTHER_CAMERA = 700
const STALE_MESSAGE =
  'bindings: a stored wrapper activation names a cap with no wrapper — ignored, the cap resolves to its native'
const UNCHECKED_MESSAGE =
  'bindings: could not read the stored wrapper activations — retired-wrapper rows not checked'

interface WarnCall {
  readonly message: string
  readonly meta: unknown
}

function recordingLogger(): { readonly logger: IScopedLogger; readonly warns: WarnCall[] } {
  const warns: WarnCall[] = []
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      warns.push({ message, meta })
    }),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return { logger, warns }
}

interface SettingsOptions {
  readonly deviceBindings: Record<string, Record<string, { wrapperAddonId: string | null }>>
}

function memorySettings(options: SettingsOptions): {
  readonly settings: NonNullable<AddonContext['settings']>
  /** The stored activations as they are NOW — the check must leave them as seeded. */
  readonly storedBindings: () => unknown
} {
  const addonStore: Record<string, unknown> = {
    deviceBindings: structuredClone(options.deviceBindings),
  }
  return {
    storedBindings: () => addonStore['deviceBindings'],
    settings: {
      readAddonStore: async () => structuredClone(addonStore),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, structuredClone(patch))
      },
      readDeviceStoreBatch: async (ids: readonly number[]) => new Map(ids.map((id) => [id, {}])),
      listDeviceStoreIds: async () => [],
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
      clearDeviceStore: async () => undefined,
      readDeviceRuntimeState: async () => ({}),
      writeDeviceRuntimeState: async () => undefined,
      clearDeviceRuntimeState: async () => undefined,
      getSection: async () => ({}),
      setSection: async () => undefined,
    },
  }
}

async function boot(options: SettingsOptions & { readonly composerNative?: boolean }) {
  const { logger, warns } = recordingLogger()
  const registry = new CapabilityRegistry(logger)
  if (options.composerNative ?? true) {
    registry.registerNativeProvider('doorbell', CAMERA, 'composer', {})
  }
  const store = await makeSettingsStoreApi()
  await seedDeviceRow(store, { deviceId: CAMERA, type: 'camera' })
  await seedDeviceRow(store, { deviceId: OTHER_CAMERA, type: 'camera' })
  const { settings, storedBindings } = memorySettings(options)
  const records = await makeRecordsAccessForOwner('device-manager')
  const addon = new DeviceManagerAddon()
  await addon.initialize(
    makeAddonContext({
      id: 'device-manager',
      logger,
      settings,
      records,
      api: { settingsStore: store.api },
      kernel: { deviceRegistry: new DeviceRegistry(), capabilityRegistry: registry },
    }),
  )
  return { addon, warns, storedBindings }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((r) => setImmediate(r))
}

function staleWarns(warns: readonly WarnCall[]): readonly WarnCall[] {
  return warns.filter((w) => w.message === STALE_MESSAGE)
}

const STALE_DOORBELL = { doorbell: { wrapperAddonId: 'virtual-doorbell' } }

describe('a stored activation of a retired wrapper (task 17 review M1)', () => {
  it('never hides the native: the composer serves the doorbell, not the retired addon', async () => {
    const { addon } = await boot({ deviceBindings: { [CAMERA]: STALE_DOORBELL } })
    const { entries } = await addon.getBindings({ deviceId: CAMERA })
    expect(entries.filter((e) => e.capName === 'doorbell')).toEqual([
      expect.objectContaining({ kind: 'native', providerAddonId: 'composer' }),
    ])
  })

  it('with no native, the cap is absent — never advertised as served by an addon that is gone', async () => {
    const { addon } = await boot({
      deviceBindings: { [CAMERA]: STALE_DOORBELL },
      composerNative: false,
    })
    const { entries } = await addon.getBindings({ deviceId: CAMERA })
    expect(entries.filter((e) => e.capName === 'doorbell')).toEqual([])
  })

  it('is said ONCE per (device, cap), tagged, naming the row and the recovery call', async () => {
    const { addon, warns } = await boot({ deviceBindings: { [CAMERA]: STALE_DOORBELL } })
    await settle()
    await addon.getBindings({ deviceId: CAMERA })
    await addon.getBindings({ deviceId: CAMERA })
    await addon.getAllBindings()
    expect(staleWarns(warns)).toEqual([
      {
        message: STALE_MESSAGE,
        meta: {
          tags: { deviceId: CAMERA },
          meta: {
            capName: 'doorbell',
            wrapperAddonId: 'virtual-doorbell',
            recovery:
              'deviceManager.setWrapperActive({ deviceId, capName, wrapperAddonId, active: false })',
          },
        },
      },
    ])
  })

  it('is said at boot for a device nobody asks about, and the row is never written', async () => {
    const { warns, storedBindings } = await boot({
      deviceBindings: { [OTHER_CAMERA]: STALE_DOORBELL },
    })
    await settle()
    expect(staleWarns(warns).map((w) => w.meta)).toEqual([
      expect.objectContaining({ tags: { deviceId: OTHER_CAMERA } }),
    ])
    expect(storedBindings()).toEqual({ [OTHER_CAMERA]: STALE_DOORBELL })
  })

  it('a valid wrapper activation is routed to its wrapper and never warned', async () => {
    const { addon, warns } = await boot({
      deviceBindings: { [CAMERA]: { 'ptz-autotrack': { wrapperAddonId: 'autotrack' } } },
    })
    await settle()
    const { entries } = await addon.getBindings({ deviceId: CAMERA })
    expect(entries.filter((e) => e.capName === 'ptz-autotrack')).toEqual([
      expect.objectContaining({ kind: 'wrapped', providerAddonId: 'autotrack' }),
    ])
    expect(staleWarns(warns)).toEqual([])
  })

  it('a failed read changes nothing and says it could not check; the next answered read does', async () => {
    const { logger, warns } = recordingLogger()
    const check = new StaleWrapperActivations(logger)
    await check.checkOnce(async () => {
      throw new Error('settings door timed out')
    })
    expect(warns).toEqual([
      { message: UNCHECKED_MESSAGE, meta: { meta: { error: 'settings door timed out' } } },
    ])

    const store: DeviceBindingsStore = { deviceBindings: { [OTHER_CAMERA]: STALE_DOORBELL } }
    await check.checkOnce(async () => store)
    await check.checkOnce(async () => store)
    expect(staleWarns(warns).map((w) => w.meta)).toEqual([
      expect.objectContaining({ tags: { deviceId: OTHER_CAMERA } }),
    ])
  })

  it('a corrupt blob never throws, at boot or in a pass; the rows that ARE readable are still judged (N1)', async () => {
    const { logger, warns } = recordingLogger()
    const check = new StaleWrapperActivations(logger)
    // A blob a hand edit or a partial write left behind: a null device, a null
    // row, a non-object row. Built at an untyped boundary.
    const corrupt: DeviceBindingsStore = JSON.parse(
      JSON.stringify({
        deviceBindings: {
          '1': null,
          '2': { doorbell: null, switch: 7 },
          [OTHER_CAMERA]: STALE_DOORBELL,
        },
      }),
    )
    await expect(check.checkOnce(async () => corrupt)).resolves.toBeUndefined()
    expect(staleWarns(warns).map((w) => w.meta)).toEqual([
      expect.objectContaining({ tags: { deviceId: OTHER_CAMERA } }),
    ])
  })

  it('a throw while checking is logged, never an unhandled rejection under the boot promise (N1)', async () => {
    const { logger, warns } = recordingLogger()
    const check = new StaleWrapperActivations(logger)
    const hostile: DeviceBindingsStore['deviceBindings'] = {}
    Object.defineProperty(hostile, String(OTHER_CAMERA), {
      enumerable: true,
      get() {
        throw new Error('row unreadable')
      },
    })
    await expect(
      check.checkOnce(async () => ({ deviceBindings: hostile })),
    ).resolves.toBeUndefined()
    expect(warns).toEqual([
      { message: UNCHECKED_MESSAGE, meta: { meta: { error: 'row unreadable' } } },
    ])
  })
})
