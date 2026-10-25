/**
 * The 2026-09-01 incident, as executable claims.
 *
 * `swapIds` moved the device rows and nothing moved the per-device state:
 * device 108 (new Reolink hardware) kept `host=192.168.10.245, port=80,
 * deviceCache.model="DS-2DE2A404IW-DE3/W"` — the replaced Hikvision's address,
 * credentials and cached model — and was dialled at a dead address forever.
 * These specs pin the rule: driver config and runtime state (hardware
 * descriptions) SWAP; the device-manager section keys (role) STAY; the legacy
 * `_profileMap` is DROPPED from both.
 */
import { describe, expect, it } from 'vitest'
import {
  LINKED_IDS_CONFIG_KEY,
  LINKED_MODE_CONFIG_KEY,
  LINKED_TRACKED_IDS_CONFIG_KEY,
} from '../device-linked-devices.js'
import {
  assertNoFieldClaims,
  FieldClaimsBlockMigrationError,
  swapHardwareState,
  type HardwareStateStore,
} from '../migrate-hardware-state.js'

const SOURCE = 108
const TARGET = 4362

interface FakeStore {
  readonly store: HardwareStateStore
  readonly configs: Map<number, Record<string, unknown>>
  readonly runtime: Map<number, Record<string, unknown>>
}

function fakeStore(
  configs: Record<number, Record<string, unknown>>,
  runtime: Record<number, Record<string, unknown>> = {},
): FakeStore {
  const configMap = new Map<number, Record<string, unknown>>(
    Object.entries(configs).map(([k, v]) => [Number(k), { ...v }]),
  )
  const runtimeMap = new Map<number, Record<string, unknown>>(
    Object.entries(runtime).map(([k, v]) => [Number(k), { ...v }]),
  )
  const store: HardwareStateStore = {
    readDeviceStore: async (id) => ({ ...configMap.get(id) }),
    // MERGE, like the real settings surface — the swap must not rely on
    // replace semantics it does not have.
    writeDeviceStore: async (id, patch) => {
      configMap.set(id, { ...configMap.get(id), ...patch })
    },
    clearDeviceStore: async (id) => {
      configMap.delete(id)
    },
    readDeviceRuntimeState: async (id) => ({ ...runtimeMap.get(id) }),
    // Whole-blob replace, per the runtime-state contract.
    writeDeviceRuntimeState: async (id, data) => {
      runtimeMap.set(id, { ...data })
    },
  }
  return { store, configs: configMap, runtime: runtimeMap }
}

const HIKVISION_CONFIG = {
  host: '192.168.10.245',
  port: 80,
  username: 'admin',
  password: 'hik-secret',
  deviceCache: { model: 'DS-2DE2A404IW-DE3/W' },
  motionSensitivity: 60,
}

const REOLINK_CONFIG = {
  host: '192.168.10.121',
  port: 9000,
  username: 'admin',
  password: 'reo-secret',
  deviceCache: { model: 'E1 Outdoor Pro' },
  motionSensitivity: 40,
}

describe('swapHardwareState — the config describes the box and goes with it', () => {
  it('after the swap, each number wears the OTHER hardware config', async () => {
    const f = fakeStore({ [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG })

    await swapHardwareState(f.store, SOURCE, TARGET)

    expect(f.configs.get(SOURCE)).toEqual(REOLINK_CONFIG)
    expect(f.configs.get(TARGET)).toEqual(HIKVISION_CONFIG)
  })

  it('role-scoped section keys STAY with the number', async () => {
    const f = fakeStore({
      [SOURCE]: {
        ...HIKVISION_CONFIG,
        [LINKED_MODE_CONFIG_KEY]: 'manual',
        [LINKED_IDS_CONFIG_KEY]: [101, 102],
      },
      [TARGET]: REOLINK_CONFIG,
    })

    await swapHardwareState(f.store, SOURCE, TARGET)

    // The driveway's linked sensors watch the driveway, whichever box films it.
    expect(f.configs.get(SOURCE)).toEqual({
      ...REOLINK_CONFIG,
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      [LINKED_IDS_CONFIG_KEY]: [101, 102],
    })
    expect(f.configs.get(TARGET)).toEqual(HIKVISION_CONFIG)
  })

  it('all three linked-devices keys stay with the number — the tracked-event opt-in included (D655)', async () => {
    const role = {
      [LINKED_MODE_CONFIG_KEY]: 'manual',
      [LINKED_IDS_CONFIG_KEY]: [101, 102],
      [LINKED_TRACKED_IDS_CONFIG_KEY]: [101],
    }
    const f = fakeStore({ [SOURCE]: { ...HIKVISION_CONFIG, ...role }, [TARGET]: REOLINK_CONFIG })

    await swapHardwareState(f.store, SOURCE, TARGET)

    // The driveway's opt-in is about the driveway, not about the box filming it.
    expect(f.configs.get(SOURCE)).toEqual({ ...REOLINK_CONFIG, ...role })
    expect(f.configs.get(TARGET)).toEqual(HIKVISION_CONFIG)
    expect(f.configs.get(TARGET)).not.toHaveProperty(LINKED_TRACKED_IDS_CONFIG_KEY)
  })

  it('the legacy `_profileMap` is dropped from BOTH — either copy names the wrong streams', async () => {
    const f = fakeStore({
      [SOURCE]: { ...HIKVISION_CONFIG, _profileMap: { high: 'high', mid: 'native:slot-3' } },
      [TARGET]: { ...REOLINK_CONFIG, _profileMap: { high: 'native:main' } },
    })

    await swapHardwareState(f.store, SOURCE, TARGET)

    expect(f.configs.get(SOURCE)).not.toHaveProperty('_profileMap')
    expect(f.configs.get(TARGET)).not.toHaveProperty('_profileMap')
  })

  it('runtime-state blobs swap wholesale and are returned for the mirror reseed', async () => {
    const sourceState = { 'device-status': { online: false }, 'feature-probe': { lastProbedAt: 5 } }
    const targetState = { 'device-status': { online: true } }
    const f = fakeStore(
      { [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG },
      { [SOURCE]: sourceState, [TARGET]: targetState },
    )

    const swapped = await swapHardwareState(f.store, SOURCE, TARGET)

    expect(f.runtime.get(SOURCE)).toEqual(targetState)
    expect(f.runtime.get(TARGET)).toEqual(sourceState)
    expect(swapped.runtimeStateNowAtSource).toEqual(targetState)
    expect(swapped.runtimeStateNowAtTarget).toEqual(sourceState)
  })

  it('reports which keys moved and which stayed, for the migration log', async () => {
    const f = fakeStore({
      [SOURCE]: { host: 'a', [LINKED_MODE_CONFIG_KEY]: 'manual', _profileMap: {} },
      [TARGET]: { host: 'b', port: 9000 },
    })

    const swapped = await swapHardwareState(f.store, SOURCE, TARGET)

    expect(swapped.hardwareKeysToSource).toEqual(['host', 'port'])
    expect(swapped.hardwareKeysToTarget).toEqual(['host'])
    expect(swapped.roleKeysKeptAtSource).toEqual([LINKED_MODE_CONFIG_KEY])
    expect(swapped.roleKeysKeptAtTarget).toEqual([])
  })

  it('a device with an empty config swaps to empty — unknown is the truth, not an error', async () => {
    const f = fakeStore({ [SOURCE]: HIKVISION_CONFIG, [TARGET]: {} })

    await swapHardwareState(f.store, SOURCE, TARGET)

    expect(f.configs.get(SOURCE) ?? {}).toEqual({})
    expect(f.configs.get(TARGET)).toEqual(HIKVISION_CONFIG)
  })
})

describe('assertNoFieldClaims — a claim blocks the migration (D663)', () => {
  const CLAIMED = {
    'device-status': { online: true },
    $owned: {
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['percentage'],
        values: { percentage: 90 },
      },
    },
  }

  it('refuses by name when the SOURCE row carries $owned, and moves nothing', async () => {
    const f = fakeStore(
      { [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG },
      { [SOURCE]: CLAIMED, [TARGET]: {} },
    )
    await expect(assertNoFieldClaims(f.store, SOURCE, TARGET)).rejects.toThrow(
      /migration 108 → 4362 refused: device 108 has fields claimed by a customization \(battery \[percentage\]: blk-1\) — delete the customization before migrating/,
    )
    expect(f.configs.get(SOURCE)).toEqual(HIKVISION_CONFIG)
    expect(f.runtime.get(SOURCE)).toEqual(CLAIMED)
  })

  it('refuses when the TARGET row carries $owned — and the error carries the claims structurally', async () => {
    const f = fakeStore(
      { [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG },
      { [SOURCE]: {}, [TARGET]: CLAIMED },
    )
    const err = await assertNoFieldClaims(f.store, SOURCE, TARGET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FieldClaimsBlockMigrationError)
    if (!(err instanceof FieldClaimsBlockMigrationError)) return
    expect(err.message).toMatch(/device 4362 has fields claimed/)
    expect(err.message).not.toMatch(/device 108 has/)
    expect(err.blocked).toEqual([
      { deviceId: TARGET, claims: [{ cap: 'battery', owner: 'blk-1', fields: ['percentage'] }] },
    ])
  })

  it('names BOTH devices when both rows carry a claim', async () => {
    const f = fakeStore(
      { [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG },
      { [SOURCE]: CLAIMED, [TARGET]: CLAIMED },
    )
    await expect(assertNoFieldClaims(f.store, SOURCE, TARGET)).rejects.toThrow(
      /device 108 has fields claimed .*; device 4362 has fields claimed/,
    )
  })

  it('passes two rows with no $owned, and a row whose $owned is EMPTY', async () => {
    const f = fakeStore(
      { [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG },
      { [SOURCE]: { 'device-status': { online: true } }, [TARGET]: { $owned: {} } },
    )
    await expect(assertNoFieldClaims(f.store, SOURCE, TARGET)).resolves.toBeUndefined()
  })

  it('a row that cannot be READ refuses the migration — unknown is never "no claim" (D49)', async () => {
    const f = fakeStore({ [SOURCE]: HIKVISION_CONFIG, [TARGET]: REOLINK_CONFIG })
    const store: HardwareStateStore = {
      ...f.store,
      readDeviceRuntimeState: async () => {
        throw new Error('sqlite busy')
      },
    }
    await expect(assertNoFieldClaims(store, SOURCE, TARGET)).rejects.toThrow(/sqlite busy/)
  })
})
