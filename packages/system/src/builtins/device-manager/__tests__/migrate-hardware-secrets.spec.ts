/**
 * The 2026-11-23 live case: camera 3628 (NVR child) replaced by standalone 5920.
 * The password marker names the keychain scope of a DEVICE NUMBER
 * (`secret://provider-reolink/device/<id>/password`); the swap moved the
 * markers with the config and nothing moved the secrets, so removing the
 * leftover 5920 deleted the password the migrated 3628 reads.
 */
import { describe, expect, it } from 'vitest'
import {
  assertNoCrossedSecretScopes,
  type HardwareStateStore,
  SecretScopesCrossedError,
  swapHardwareState,
} from '../migrate-hardware-state.js'
import { MigrationRefusedError } from '../migration-refused.js'

const NVR = 'secret://provider-reolink/device/3628/password'
const OWN = 'secret://provider-reolink/device/5920/password'

function marker(ref: string): { $secret: string; v: 1 } {
  return { $secret: ref, v: 1 }
}

interface FakeStore {
  readonly store: HardwareStateStore
  readonly configs: Map<number, Record<string, unknown>>
}

function fakeStore(configs: Record<number, Record<string, unknown>>): FakeStore {
  const configMap = new Map<number, Record<string, unknown>>(
    Object.entries(configs).map(([k, v]) => [Number(k), { ...v }]),
  )
  const store: HardwareStateStore = {
    readDeviceStore: async (id) => ({ ...configMap.get(id) }),
    writeDeviceStore: async (id, patch) => {
      configMap.set(id, { ...configMap.get(id), ...patch })
    },
    clearDeviceStore: async (id) => {
      configMap.delete(id)
    },
    readDeviceRuntimeState: async () => ({}),
    writeDeviceRuntimeState: async () => {},
  }
  return { store, configs: configMap }
}

interface Door {
  readonly calls: Array<[number, number]>
  readonly swapDeviceScopes: (
    a: number,
    b: number,
  ) => Promise<{ readonly refsNowAtA: readonly string[]; readonly refsNowAtB: readonly string[] }>
}

function door(fail?: Error): Door {
  const calls: Array<[number, number]> = []
  return {
    calls,
    swapDeviceScopes: async (a, b) => {
      calls.push([a, b])
      if (fail !== undefined) throw fail
      return { refsNowAtA: [NVR], refsNowAtB: [OWN] }
    },
  }
}

const NVR_LOGIN = { host: '192.0.2.9', username: 'admin', password: marker(NVR) }
const CAMERA = { host: '192.0.2.50', username: 'cam', password: marker(OWN) }

// What an earlier migration left: each config names the OTHER number's scope.
const CROSSED_3628 = { ...CAMERA, password: marker(OWN) }
const CROSSED_5920 = { ...NVR_LOGIN, password: marker(NVR) }

describe('a pair an earlier migration left crossed is refused, never swapped again', () => {
  it('the pre-check refuses with a typed reason, before anything moves', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })

    const refusal = assertNoCrossedSecretScopes(f.store, 3628, 5920)

    await expect(refusal).rejects.toBeInstanceOf(SecretScopesCrossedError)
    await expect(refusal).rejects.toBeInstanceOf(MigrationRefusedError)
    await expect(refusal).rejects.toThrow(/secret-scopes-crossed.*repairMigrationSecrets/)
  })

  it('refuses when only ONE side is crossed', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: { host: 'b' } })

    await expect(assertNoCrossedSecretScopes(f.store, 3628, 5920)).rejects.toThrow(
      /device 3628 holds 1 secret marker/,
    )
  })

  it('passes a normal pair (each marker names its own scope)', async () => {
    const f = fakeStore({ 3628: NVR_LOGIN, 5920: CAMERA })

    await expect(assertNoCrossedSecretScopes(f.store, 3628, 5920)).resolves.toBeUndefined()
  })

  it('swapHardwareState itself refuses a crossed pair: no exchange, no config written', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })
    const d = door()

    await expect(swapHardwareState(f.store, 3628, 5920, d)).rejects.toThrow(/secret-scopes-crossed/)

    expect(d.calls).toEqual([])
    expect(f.configs.get(3628)).toEqual(CROSSED_3628)
    expect(f.configs.get(5920)).toEqual(CROSSED_5920)
  })

  it('swapHardwareState refuses a crossed pair even without a keychain door', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })

    await expect(swapHardwareState(f.store, 3628, 5920, undefined)).rejects.toThrow(
      /secret-scopes-crossed/,
    )
  })
})

describe('swapHardwareState — the secrets follow the config (D339)', () => {
  it('each number ends up with markers that point at its OWN scope', async () => {
    const f = fakeStore({ 3628: NVR_LOGIN, 5920: CAMERA })

    await swapHardwareState(f.store, 3628, 5920, door())

    // 3628 wears the camera's config; its password marker now names device/3628.
    expect(f.configs.get(3628)).toEqual({ ...CAMERA, password: marker(NVR) })
    expect(f.configs.get(5920)).toEqual({ ...NVR_LOGIN, password: marker(OWN) })
  })

  it('exchanges the keychain scopes, and reports it', async () => {
    const f = fakeStore({ 3628: NVR_LOGIN, 5920: CAMERA })
    const d = door()

    const swapped = await swapHardwareState(f.store, 3628, 5920, d)

    expect(d.calls).toEqual([[3628, 5920]])
    expect(swapped.secretScopes).toEqual({
      exchanged: true,
      markersRepointed: 2,
      refsAtSource: [NVR],
      refsAtTarget: [OWN],
    })
  })

  it('re-points nested and listed markers, and leaves other scopes alone', async () => {
    const integration = 'secret://provider-reolink/integration/hub/token'
    const f = fakeStore({
      3628: NVR_LOGIN,
      5920: {
        ...CAMERA,
        nested: { deep: [marker(OWN)] },
        shared: marker(integration),
        plain: 'secret://not-a-marker',
      },
    })

    await swapHardwareState(f.store, 3628, 5920, door())

    expect(f.configs.get(3628)).toMatchObject({
      nested: { deep: [marker(NVR)] },
      shared: marker(integration),
      plain: 'secret://not-a-marker',
    })
  })

  it('a keychain that fails is REPORTED and no config is written', async () => {
    const f = fakeStore({ 3628: NVR_LOGIN, 5920: CAMERA })

    await expect(
      swapHardwareState(f.store, 3628, 5920, door(new Error('keychain is locked'))),
    ).rejects.toThrow(/keychain is locked/)

    expect(f.configs.get(3628)).toEqual(NVR_LOGIN)
    expect(f.configs.get(5920)).toEqual(CAMERA)
  })

  it('markers with no keychain door refuse; no markers needs no door', async () => {
    const withMarkers = fakeStore({ 3628: NVR_LOGIN, 5920: CAMERA })
    await expect(swapHardwareState(withMarkers.store, 3628, 5920, undefined)).rejects.toThrow(
      /keychain/,
    )
    expect(withMarkers.configs.get(3628)).toEqual(NVR_LOGIN)

    const plain = fakeStore({ 3628: { host: 'a' }, 5920: { host: 'b' } })
    const swapped = await swapHardwareState(plain.store, 3628, 5920, undefined)
    expect(swapped.secretScopes.exchanged).toBe(false)
    expect(plain.configs.get(3628)).toEqual({ host: 'b' })
  })
})
