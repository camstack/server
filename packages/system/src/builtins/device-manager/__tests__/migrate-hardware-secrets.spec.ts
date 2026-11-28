/**
 * The 2026-11-23 live case: camera 3628 (NVR child) replaced by standalone 5920.
 * The password marker names the keychain scope of a DEVICE NUMBER
 * (`secret://provider-reolink/device/<id>/password`); the swap moved the
 * markers with the config and nothing moved the secrets, so removing the
 * leftover 5920 deleted the password the migrated 3628 reads.
 *
 * The swap now writes the configs with their markers unchanged and runs the
 * crash-idempotent repair, so a crash while the secrets move loses nothing.
 */
import { isSecretMarker } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  assertNoCrossedSecretScopes,
  type HardwareStateStore,
  type RepairSecretsDoor,
  repairCrossedSecretScopes,
  SecretScopesCrossedError,
  swapHardwareState,
} from '../migrate-hardware-state.js'
import { MigrationRefusedError } from '../migration-refused.js'

const NVR = 'secret://provider-reolink/device/3628/password'
const OWN = 'secret://provider-reolink/device/5920/password'

function marker(ref: string): { $secret: string; v: 1 } {
  return { $secret: ref, v: 1 }
}

/** A fake store and keychain; every mutation counts, and the one numbered `failAt` throws. */
interface Rig {
  readonly store: HardwareStateStore
  readonly door: RepairSecretsDoor
  readonly configs: Map<number, Record<string, unknown>>
  readonly keychain: Map<string, string>
  readonly calls: { mutations: number; failAt: number | null }
}

function rig(
  configs: Record<number, Record<string, unknown>>,
  secrets: Record<string, string>,
): Rig {
  const calls: { mutations: number; failAt: number | null } = { mutations: 0, failAt: null }
  const configMap = new Map(Object.entries(configs).map(([k, v]) => [Number(k), { ...v }]))
  const keychain = new Map(Object.entries(secrets))
  const tick = (): void => {
    calls.mutations += 1
    if (calls.failAt === calls.mutations) throw new Error(`injected failure at ${calls.mutations}`)
  }
  const store: HardwareStateStore = {
    readDeviceStore: async (id) => ({ ...configMap.get(id) }),
    writeDeviceStore: async (id, patch) => {
      tick()
      configMap.set(id, { ...configMap.get(id), ...patch })
    },
    clearDeviceStore: async (id) => {
      configMap.delete(id)
    },
    readDeviceRuntimeState: async () => ({}),
    writeDeviceRuntimeState: async () => {},
  }
  const door: RepairSecretsDoor = {
    forOwner: () => ({
      resolve: async (refs) =>
        Object.fromEntries(
          refs.map((ref) => {
            const value = keychain.get(ref)
            return [
              ref,
              value === undefined ? { kind: 'missing' } : { kind: 'value', value, version: 1 },
            ]
          }),
        ),
      put: async (ref, value) => {
        tick()
        keychain.set(ref, value)
        return 1
      },
      delete: async (refs) => {
        tick()
        for (const ref of refs) keychain.delete(ref)
        return refs.length
      },
    }),
  }
  return { store, door, configs: configMap, keychain, calls }
}

// The NVR login's password lives under the NVR child's number (Y), the
// camera's under its own (X).
const KEYCHAIN = { [OWN]: 'X-camera', [NVR]: 'Y-nvr' }

const NVR_LOGIN = { host: '192.0.2.9', username: 'admin', password: marker(NVR) }
const CAMERA = { host: '192.0.2.50', username: 'cam', password: marker(OWN) }

// What an earlier migration left: each config names the OTHER number's scope.
const CROSSED_3628 = { ...CAMERA, password: marker(OWN) }
const CROSSED_5920 = { ...NVR_LOGIN, password: marker(NVR) }

describe('a pair an earlier migration left crossed is refused, never swapped again', () => {
  it('the pre-check refuses with a typed reason, before anything moves', async () => {
    const f = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    const refusal = assertNoCrossedSecretScopes(f.store, 3628, 5920)

    await expect(refusal).rejects.toBeInstanceOf(SecretScopesCrossedError)
    await expect(refusal).rejects.toBeInstanceOf(MigrationRefusedError)
    await expect(refusal).rejects.toThrow(/secret-scopes-crossed.*repairMigrationSecrets/)
  })

  it('refuses when only ONE side is crossed', async () => {
    const f = rig({ 3628: CROSSED_3628, 5920: { host: 'b' } }, KEYCHAIN)

    await expect(assertNoCrossedSecretScopes(f.store, 3628, 5920)).rejects.toThrow(
      /device 3628 holds 1 secret marker/,
    )
  })

  it('passes a normal pair (each marker names its own scope)', async () => {
    const f = rig({ 3628: NVR_LOGIN, 5920: CAMERA }, KEYCHAIN)

    await expect(assertNoCrossedSecretScopes(f.store, 3628, 5920)).resolves.toBeUndefined()
  })

  it('swapHardwareState itself refuses a crossed pair: nothing written', async () => {
    const f = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    await expect(swapHardwareState(f.store, 3628, 5920, f.door)).rejects.toThrow(
      /secret-scopes-crossed/,
    )

    expect(f.calls.mutations).toBe(0)
    expect(f.configs.get(3628)).toEqual(CROSSED_3628)
    expect(f.configs.get(5920)).toEqual(CROSSED_5920)
  })

  it('swapHardwareState refuses a crossed pair even without a keychain door', async () => {
    const f = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    await expect(swapHardwareState(f.store, 3628, 5920, undefined)).rejects.toThrow(
      /secret-scopes-crossed/,
    )
  })
})

function expectSwapped(r: Rig, orphans: 'none' | 'staging-copies-allowed' = 'none'): void {
  // 3628 wears the camera's config, 5920 the NVR login; each marker names its
  // OWN number's scope and reads the value it always read.
  expect(r.configs.get(3628)).toEqual({ ...CAMERA, password: marker(NVR) })
  expect(r.configs.get(5920)).toEqual({ ...NVR_LOGIN, password: marker(OWN) })
  expect(r.keychain.get(NVR)).toBe('X-camera')
  expect(r.keychain.get(OWN)).toBe('Y-nvr')
  // A crash in the last step (the deletes) leaves only staging copies, which a
  // device removal purges with its scope; never a value under another ref.
  const keys = [...r.keychain.keys()].filter(
    (ref) => orphans === 'none' || !ref.endsWith('~repair'),
  )
  expect(keys.toSorted()).toEqual([NVR, OWN].toSorted())
}

describe('swapHardwareState — the secrets follow the config (D339)', () => {
  it('each number ends up with markers that point at its OWN scope, values moved', async () => {
    const r = rig({ 3628: NVR_LOGIN, 5920: CAMERA }, KEYCHAIN)

    const swapped = await swapHardwareState(r.store, 3628, 5920, r.door)

    expectSwapped(r)
    expect(swapped.secretScopes).toEqual({
      exchanged: true,
      markersRepointed: 2,
      refsAtSource: [NVR],
      refsAtTarget: [OWN],
    })
  })

  it('moves nested and listed markers, and leaves other scopes alone', async () => {
    const integration = 'secret://provider-reolink/integration/hub/token'
    const r = rig(
      {
        3628: NVR_LOGIN,
        5920: {
          ...CAMERA,
          nested: { deep: [marker(OWN)] },
          shared: marker(integration),
          plain: 'secret://not-a-marker',
        },
      },
      { ...KEYCHAIN, [integration]: 'hub-token' },
    )

    await swapHardwareState(r.store, 3628, 5920, r.door)

    expect(r.configs.get(3628)).toMatchObject({
      nested: { deep: [marker(NVR)] },
      shared: marker(integration),
      plain: 'secret://not-a-marker',
    })
    expect(r.keychain.get(integration)).toBe('hub-token')
  })

  it('markers with no keychain door refuse before a byte moves; no markers needs no door', async () => {
    const withMarkers = rig({ 3628: NVR_LOGIN, 5920: CAMERA }, KEYCHAIN)
    await expect(swapHardwareState(withMarkers.store, 3628, 5920, undefined)).rejects.toThrow(
      /keychain/,
    )
    expect(withMarkers.configs.get(3628)).toEqual(NVR_LOGIN)

    const plain = rig({ 3628: { host: 'a' }, 5920: { host: 'b' } }, {})
    const swapped = await swapHardwareState(plain.store, 3628, 5920, undefined)
    expect(swapped.secretScopes.exchanged).toBe(false)
    expect(plain.configs.get(3628)).toEqual({ host: 'b' })
  })
})

// Ticks 1-2 are the swap's own config writes (a crash between those is the
// accepted, loud pre-existing state); every later tick is a step of the repair.
const FIRST_REPAIR_TICK = 3

describe('swapHardwareState — a crash while the secrets move loses nothing', () => {
  it('a failure at ANY repair step names the repair, keeps every marker readable, and the repair finishes it', async () => {
    const whole = rig({ 3628: NVR_LOGIN, 5920: CAMERA }, KEYCHAIN)
    await swapHardwareState(whole.store, 3628, 5920, whole.door)
    expect(whole.calls.mutations).toBeGreaterThan(FIRST_REPAIR_TICK)

    for (let failAt = FIRST_REPAIR_TICK; failAt <= whole.calls.mutations; failAt++) {
      const r = rig({ 3628: NVR_LOGIN, 5920: CAMERA }, KEYCHAIN)
      r.calls.failAt = failAt

      await expect(swapHardwareState(r.store, 3628, 5920, r.door)).rejects.toThrow(
        /repairMigrationSecrets/,
      )

      // Whatever step died, every marker still names a value that exists.
      for (const id of [3628, 5920]) {
        const password = r.configs.get(id)?.password
        expect(isSecretMarker(password), `device ${id} at step ${failAt}`).toBe(true)
        if (isSecretMarker(password)) {
          expect(r.keychain.has(password.$secret), `device ${id} at step ${failAt}`).toBe(true)
        }
      }
      r.calls.failAt = null
      await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)
      expectSwapped(r, 'staging-copies-allowed')
    }
  })
})
