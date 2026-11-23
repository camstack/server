/**
 * The live repair for a migration that ran before the secrets followed the
 * config (2026-11-23, 3628 / 5920): each number's config carries a marker for
 * the OTHER number's keychain scope. Repair brings every such marker's value
 * under the number whose config holds it, with the configs as the state
 * machine, so a crash at ANY step is re-run to the same, correct end state.
 */
import { describe, expect, it } from 'vitest'
import {
  type HardwareStateStore,
  type RepairSecretsDoor,
  repairCrossedSecretScopes,
} from '../migrate-hardware-state.js'

const NVR = 'secret://provider-reolink/device/3628/password'
const OWN = 'secret://provider-reolink/device/5920/password'

function marker(ref: string): { $secret: string; v: 1 } {
  return { $secret: ref, v: 1 }
}

type Store = Pick<HardwareStateStore, 'readDeviceStore' | 'writeDeviceStore'>

/** Every mutating call counts; the call numbered `calls.failAt` throws. */
interface Rig {
  readonly store: Store
  readonly door: RepairSecretsDoor
  readonly configs: Map<number, Record<string, unknown>>
  readonly keychain: Map<string, string>
  readonly calls: { mutations: number; failAt: number | null }
}

function rig(
  initial: Record<number, Record<string, unknown>>,
  secrets: Record<string, string>,
): Rig {
  const calls: { mutations: number; failAt: number | null } = { mutations: 0, failAt: null }
  const configs = new Map(Object.entries(initial).map(([k, v]) => [Number(k), { ...v }]))
  const keychain = new Map(Object.entries(secrets))
  const tick = (): void => {
    calls.mutations += 1
    if (calls.failAt === calls.mutations) throw new Error(`injected failure at ${calls.mutations}`)
  }
  const store: Store = {
    readDeviceStore: async (id) => ({ ...configs.get(id) }),
    writeDeviceStore: async (id, patch) => {
      tick()
      configs.set(id, { ...configs.get(id), ...patch })
    },
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
  return { store, door, configs, keychain, calls }
}

// The state the buggy migration left: 3628 wears the camera config but its
// marker names device/5920 (value X); 5920 wears the NVR login with a marker
// naming 3628 (value Y).
const CROSSED_3628 = { host: '192.0.2.50', password: marker(OWN) }
const CROSSED_5920 = { host: '192.0.2.9', password: marker(NVR) }
const KEYCHAIN = { [OWN]: 'X-camera', [NVR]: 'Y-nvr' }

function expectRepaired(r: Rig): void {
  expect(r.configs.get(3628)).toEqual({ host: '192.0.2.50', password: marker(NVR) })
  expect(r.configs.get(5920)).toEqual({ host: '192.0.2.9', password: marker(OWN) })
  // Each number's marker reads the value it always read, now under its own scope.
  expect(r.keychain.get(NVR)).toBe('X-camera')
  expect(r.keychain.get(OWN)).toBe('Y-nvr')
  expect([...r.keychain.keys()].toSorted()).toEqual([NVR, OWN].toSorted())
}

describe('repairCrossedSecretScopes', () => {
  it('a dry run reports the plan and writes nothing', async () => {
    const r = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    const report = await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, false)

    expect(report).toMatchObject({
      outcome: 'would-repair',
      markersRepointedAtA: 1,
      markersRepointedAtB: 1,
    })
    expect(r.calls.mutations).toBe(0)
    expect(r.configs.get(3628)).toEqual(CROSSED_3628)
  })

  it('--apply brings each value under its own number, with nothing left behind', async () => {
    const r = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    const report = await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)

    expect(report).toMatchObject({ outcome: 'repaired', refsNowAtA: [NVR], refsNowAtB: [OWN] })
    expectRepaired(r)
  })

  it('is idempotent: a repaired pair is left alone, nothing is exchanged back', async () => {
    const r = rig(
      { 3628: { host: 'a', password: marker(NVR) }, 5920: { host: 'b', password: marker(OWN) } },
      { [NVR]: 'X-camera', [OWN]: 'Y-nvr' },
    )

    const report = await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)

    expect(report.outcome).toBe('nothing-to-repair')
    expect(r.calls.mutations).toBe(0)
    expect(r.keychain.get(NVR)).toBe('X-camera')
  })

  it('never touches the shape the 3629/5925 migration left (each marker names its OWN scope)', async () => {
    const own3629 = 'secret://provider-reolink/device/3629/password'
    const own5925 = 'secret://provider-reolink/device/5925/password'
    const r = rig(
      { 3629: { password: marker(own3629) }, 5925: { password: marker(own5925) } },
      { [own3629]: 'p1', [own5925]: 'p2' },
    )

    const dry = await repairCrossedSecretScopes(r.store, r.door, 3629, 5925, false)
    const applied = await repairCrossedSecretScopes(r.store, r.door, 3629, 5925, true)

    expect(dry.outcome).toBe('nothing-to-repair')
    expect(applied.outcome).toBe('nothing-to-repair')
    expect(r.calls.mutations).toBe(0)
  })

  it('moves a one-sided pair: only one config holds a crossed marker', async () => {
    const r = rig({ 3628: CROSSED_3628, 5920: { host: '192.0.2.9' } }, { [OWN]: 'X-camera' })

    const report = await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)

    expect(report).toMatchObject({
      outcome: 'repaired',
      markersRepointedAtA: 1,
      markersRepointedAtB: 0,
    })
    expect(r.configs.get(3628)).toEqual({ host: '192.0.2.50', password: marker(NVR) })
    expect(r.configs.get(5920)).toEqual({ host: '192.0.2.9' })
    // The old cell no config names any more is dropped; no staging copy remains.
    expect([...r.keychain.entries()]).toEqual([[NVR, 'X-camera']])
  })

  it('keeps a value another marker of the pair still names', async () => {
    // 3628 crossed (names 5920's cell); 5920 also names that SAME cell, its own.
    const r = rig(
      { 3628: CROSSED_3628, 5920: { host: 'b', password: marker(OWN) } },
      { [OWN]: 'shared' },
    )

    await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)

    expect(r.keychain.get(OWN)).toBe('shared')
    expect(r.keychain.get(NVR)).toBe('shared')
  })

  it('a keychain door that is missing, with markers to move, throws and writes nothing', async () => {
    const r = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN)

    await expect(repairCrossedSecretScopes(r.store, undefined, 3628, 5920, true)).rejects.toThrow(
      /no keychain door/,
    )
    expect(r.calls.mutations).toBe(0)

    const clean = rig({ 3628: { host: 'a' }, 5920: { host: 'b' } }, {})
    await expect(
      repairCrossedSecretScopes(clean.store, undefined, 3628, 5920, true),
    ).resolves.toMatchObject({ outcome: 'nothing-to-repair' })
  })

  it('an unreadable value stops the repair before any write', async () => {
    const r = rig({ 3628: CROSSED_3628, 5920: CROSSED_5920 }, { [NVR]: 'Y-nvr' })

    await expect(repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)).rejects.toThrow(
      /cannot be read/,
    )

    expect(r.calls.mutations).toBe(0)
    expect(r.configs.get(3628)).toEqual(CROSSED_3628)
  })

  // The point of the design: kill the repair after EVERY mutating step, run it
  // again, and the pair always ends repaired — no value lost, none exchanged twice.
  for (const [label, configs, keychain] of [
    ['two-sided', { 3628: CROSSED_3628, 5920: CROSSED_5920 }, KEYCHAIN],
    ['one-sided', { 3628: CROSSED_3628, 5920: { host: '192.0.2.9' } }, { [OWN]: 'X-camera' }],
  ] as const) {
    it(`${label}: a failure after any step, then a re-run, reaches the repaired state`, async () => {
      const probe = rig(configs, keychain)
      await repairCrossedSecretScopes(probe.store, probe.door, 3628, 5920, true)
      const steps = probe.calls.mutations
      expect(steps).toBeGreaterThan(4)

      for (let failAt = 1; failAt <= steps; failAt++) {
        const r = rig(configs, keychain)
        r.calls.failAt = failAt
        await expect(repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)).rejects.toThrow(
          /injected failure/,
        )

        r.calls.failAt = null
        await repairCrossedSecretScopes(r.store, r.door, 3628, 5920, true)

        const own3628 = r.keychain.get(NVR)
        expect(own3628, `failAt ${failAt}`).toBe('X-camera')
        expect(r.configs.get(3628), `failAt ${failAt}`).toEqual({
          host: '192.0.2.50',
          password: marker(NVR),
        })
        if (label === 'two-sided') {
          expect(r.keychain.get(OWN), `failAt ${failAt}`).toBe('Y-nvr')
          expect(r.configs.get(5920), `failAt ${failAt}`).toEqual({
            host: '192.0.2.9',
            password: marker(OWN),
          })
        }
      }
    })
  }
})
