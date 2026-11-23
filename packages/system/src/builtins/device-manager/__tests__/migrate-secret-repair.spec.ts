/**
 * The live repair for a migration that ran before the secrets followed the
 * config (2026-11-23, 3628 / 5920): each number's config carries a marker for
 * the OTHER number's keychain scope. Repair re-points each config's markers at
 * its own number and exchanges the two keychain scopes — together, so every
 * marker keeps reading the value it always read, now under its own number.
 */
import { describe, expect, it } from 'vitest'
import { type HardwareStateStore, repairCrossedSecretScopes } from '../migrate-hardware-state.js'

const NVR = 'secret://provider-reolink/device/3628/password'
const OWN = 'secret://provider-reolink/device/5920/password'

function marker(ref: string): { $secret: string; v: 1 } {
  return { $secret: ref, v: 1 }
}

type Store = Pick<HardwareStateStore, 'readDeviceStore' | 'writeDeviceStore'>

function fakeStore(configs: Record<number, Record<string, unknown>>): {
  readonly store: Store
  readonly configs: Map<number, Record<string, unknown>>
} {
  const map = new Map<number, Record<string, unknown>>(
    Object.entries(configs).map(([k, v]) => [Number(k), { ...v }]),
  )
  return {
    configs: map,
    store: {
      readDeviceStore: async (id) => ({ ...map.get(id) }),
      writeDeviceStore: async (id, patch) => {
        map.set(id, { ...map.get(id), ...patch })
      },
    },
  }
}

function door(): {
  readonly calls: Array<[number, number]>
  readonly swapDeviceScopes: (
    a: number,
    b: number,
  ) => Promise<{ readonly refsNowAtA: readonly string[]; readonly refsNowAtB: readonly string[] }>
} {
  const calls: Array<[number, number]> = []
  return {
    calls,
    swapDeviceScopes: async (a, b) => {
      calls.push([a, b])
      return { refsNowAtA: [NVR], refsNowAtB: [OWN] }
    },
  }
}

// The state the buggy migration left: 3628 wears the camera config but its
// marker names device/5920; 5920 wears the NVR login with a marker naming 3628.
const CROSSED_3628 = { host: '192.0.2.50', password: marker(OWN) }
const CROSSED_5920 = { host: '192.0.2.9', password: marker(NVR) }

describe('repairCrossedSecretScopes', () => {
  it('a dry run reports the plan and writes nothing', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })
    const d = door()

    const report = await repairCrossedSecretScopes(f.store, d, 3628, 5920, false)

    expect(report).toMatchObject({
      outcome: 'would-repair',
      markersRepointedAtA: 1,
      markersRepointedAtB: 1,
    })
    expect(d.calls).toEqual([])
    expect(f.configs.get(3628)).toEqual(CROSSED_3628)
  })

  it('--apply re-points both configs and exchanges the scopes', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })
    const d = door()

    const report = await repairCrossedSecretScopes(f.store, d, 3628, 5920, true)

    expect(report.outcome).toBe('repaired')
    expect(d.calls).toEqual([[3628, 5920]])
    expect(f.configs.get(3628)).toEqual({ host: '192.0.2.50', password: marker(NVR) })
    expect(f.configs.get(5920)).toEqual({ host: '192.0.2.9', password: marker(OWN) })
    expect(report.refsNowAtA).toEqual([NVR])
    expect(report.refsNowAtB).toEqual([OWN])
  })

  it('is idempotent: a repaired pair is left alone, the keychain is not swapped back', async () => {
    const f = fakeStore({
      3628: { host: 'a', password: marker(NVR) },
      5920: { host: 'b', password: marker(OWN) },
    })
    const d = door()

    const report = await repairCrossedSecretScopes(f.store, d, 3628, 5920, true)

    expect(report.outcome).toBe('nothing-to-repair')
    expect(d.calls).toEqual([])
  })

  it('refuses a one-sided crossing rather than guess which scope is right', async () => {
    const f = fakeStore({
      3628: CROSSED_3628,
      5920: { host: 'b', password: marker(OWN) },
    })
    const d = door()

    const report = await repairCrossedSecretScopes(f.store, d, 3628, 5920, true)

    expect(report.outcome).toBe('refused-one-sided')
    expect(d.calls).toEqual([])
    expect(f.configs.get(3628)).toEqual(CROSSED_3628)
  })

  it('a keychain that fails is reported and no config is written', async () => {
    const f = fakeStore({ 3628: CROSSED_3628, 5920: CROSSED_5920 })
    const failing = {
      swapDeviceScopes: async () => {
        throw new Error('keychain is locked')
      },
    }

    await expect(repairCrossedSecretScopes(f.store, failing, 3628, 5920, true)).rejects.toThrow(
      /keychain is locked/,
    )

    expect(f.configs.get(3628)).toEqual(CROSSED_3628)
    expect(f.configs.get(5920)).toEqual(CROSSED_5920)
  })
})
