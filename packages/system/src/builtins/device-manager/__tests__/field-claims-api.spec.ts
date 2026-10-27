/**
 * The `deviceState` claim methods on the REAL device-manager (D663, Task 6):
 * `claimFields` / `patchOwnedFields` / `releaseClaim` / `listClaims`, the
 * claims INDEX they keep (one addon-store blob, written before the row on a
 * claim and after it on a release), and what the index buys the seed.
 *
 * The index is a listing projection — the row is the merge authority. Three
 * conditions keep it honest and each is a test here: `removeDevice` prunes it
 * (i); an entry whose release answers `not-claimed` is removed (ii); it is a
 * superset of the rows' claims, so a loaded index that does not name a device
 * lets its status read and native write skip the row read (S6, D447). It
 * never lets a ROW WRITE skip it: the index knows the claims, not the native
 * slices beside them, and a row write replaces the whole row — the writer
 * reads first (D677).
 *
 * Neutralisation is in the brief's disarm list: answer `loaded` before the
 * load, swap the index/row write order, infer `fields` from `values`, drop the
 * prune — one test each goes red.
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FieldClaimsIndex } from '../field-claims-index.js'
import { OWNED_FIELDS_KEY } from '../field-ownership.js'
import { type Harness, registerCamera, setup } from './device-manager-harness.js'

const PROVIDERS = { reloadableProviders: ['provider-hikvision', 'provider-reolink'] }
const NATIVE = { level: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNER = 'blk-1'

async function cameraWithBattery(h: Harness, stableId = 'cam-a'): Promise<number> {
  const id = await registerCamera(h, 'provider-hikvision', stableId)
  await h.setCapSlice(id, 'battery', NATIVE)
  return id
}

function claim(
  h: Harness,
  deviceId: number,
  fields: readonly string[],
  values: Record<string, unknown>,
) {
  return h.deviceState.claimFields({
    deviceId,
    capName: 'battery',
    owner: OWNER,
    mode: 'replace',
    fields,
    values,
  })
}

describe('claimFields / patchOwnedFields — the planned field set is explicit (S5)', () => {
  it('a claimed field with no value HOLDS the cap; the patch that completes it makes the merge appear', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)

    const c = await claim(h, id, ['level', 'charging'], { level: 90 })
    expect(c).toEqual({ ok: true, changed: true })
    expect(await h.deviceState.listClaims({})).toEqual({
      state: 'loaded',
      claims: [
        {
          deviceId: id,
          capName: 'battery',
          owner: OWNER,
          mode: 'replace',
          fields: ['level', 'charging'],
        },
      ],
    })
    // Held: `charging` is claimed and unwritten — never answered from the native.
    expect(await h.capSlice(id, 'battery')).toBeNull()

    const p = await h.deviceState.patchOwnedFields({
      deviceId: id,
      capName: 'battery',
      owner: OWNER,
      values: { charging: 'unknown' },
    })
    expect(p).toEqual({ ok: true, changed: true })
    expect(await h.capSlice(id, 'battery')).toEqual({
      ...NATIVE,
      level: 90,
      charging: 'unknown',
    })
  })

  it('a value outside the claim is refused by name — on a patch, and on the claim itself (not stored)', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })

    const patch = await h.deviceState.patchOwnedFields({
      deviceId: id,
      capName: 'battery',
      owner: OWNER,
      values: { sleeping: true },
    })
    expect(patch).toMatchObject({ ok: false, code: 'field-not-claimed' })
    if (!patch.ok) expect(patch.message).toContain('sleeping')

    const id2 = await cameraWithBattery(h, 'cam-b')
    const rowWrites = h.settings.writeDeviceRuntimeState.mock.calls.length
    const bad = await claim(h, id2, ['level'], { level: 1, sleeping: true })
    expect(bad).toMatchObject({ ok: false, code: 'field-not-claimed' })
    if (!bad.ok) expect(bad.message).toContain('sleeping')
    // Refused before either store was touched.
    expect(h.settings.writeDeviceRuntimeState.mock.calls.length).toBe(rowWrites)
    const listing = await h.deviceState.listClaims({})
    expect(listing.state === 'loaded' && listing.claims.some((c) => c.deviceId === id2)).toBe(false)
  })

  it('an unknown device is a named refusal, never a throw', async () => {
    const h = await setup(PROVIDERS)
    expect(await claim(h, 999_999, ['level'], {})).toMatchObject({
      ok: false,
      code: 'unknown-device',
    })
  })
})

describe('the index is written BEFORE the row on a claim, AFTER it on a release', () => {
  it('index write fails → claim refused, row untouched, nothing listed', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    const rowWrites = h.settings.writeDeviceRuntimeState.mock.calls.length
    h.settings.writeAddonStore.mockRejectedValueOnce(new Error('sqlite busy'))

    await expect(claim(h, id, ['level'], { level: 90 })).rejects.toThrow('sqlite busy')

    expect(h.settings.writeDeviceRuntimeState.mock.calls.length).toBe(rowWrites)
    expect(await h.capSlice(id, 'battery')).toEqual(NATIVE)
    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
  })

  it('row write fails AFTER the index write → claim refused, the orphan index entry is kept, and a release self-heals it (ii)', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    h.settings.writeDeviceRuntimeState.mockRejectedValueOnce(new Error('sqlite busy'))

    await expect(claim(h, id, ['level'], { level: 90 })).rejects.toThrow('sqlite busy')

    // The native stands; the index still names the device (a crash here leaves
    // at worst an index entry with no row claim — never the reverse).
    expect(await h.capSlice(id, 'battery')).toEqual(NATIVE)
    const before = await h.deviceState.listClaims({})
    expect(before.state === 'loaded' && before.claims.map((c) => c.deviceId)).toEqual([id])

    const r = await h.deviceState.releaseClaim({ deviceId: id, capName: 'battery', owner: OWNER })
    expect(r).toMatchObject({ ok: false, code: 'not-claimed' })
    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
  })

  it('a release removes the entry after the row: the row is rewritten without $owned, then the listing is empty', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })

    const r = await h.deviceState.releaseClaim({ deviceId: id, capName: 'battery', owner: OWNER })
    expect(r).toEqual({ ok: true, changed: true })
    const lastRow = h.settings.writeDeviceRuntimeState.mock.calls.at(-1)?.[1]
    expect(lastRow).not.toHaveProperty(OWNED_FIELDS_KEY)
    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
    expect(await h.capSlice(id, 'battery')).toEqual(NATIVE)
  })

  it('a re-claim by another owner is refused and the first owner keeps its index entry', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })

    const other = await h.deviceState.claimFields({
      deviceId: id,
      capName: 'battery',
      owner: 'blk-2',
      mode: 'replace',
      fields: ['level'],
      values: {},
    })
    expect(other).toMatchObject({ ok: false, code: 'owned-by-other' })
    const listing = await h.deviceState.listClaims({})
    expect(listing.state === 'loaded' && listing.claims.map((c) => c.owner)).toEqual([OWNER])
  })
})

describe('listClaims — an index that has not loaded says so (D315)', () => {
  it('answers not-loaded while the store is unreadable, retries the load on each call, never answers []', async () => {
    const h = await setup({ ...PROVIDERS, addonStoreUnreadable: true })
    const first = await h.deviceState.listClaims({})
    expect(first.state).toBe('not-loaded')
    if (first.state === 'not-loaded') expect(first.reason).toContain('sqlite busy')

    h.addonStoreUnreadable.current = false
    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
  })

  it('filters by owner prefix', async () => {
    const h = await setup(PROVIDERS)
    const a = await cameraWithBattery(h, 'cam-a')
    const b = await cameraWithBattery(h, 'cam-b')
    await claim(h, a, ['level'], { level: 1 })
    await h.deviceState.claimFields({
      deviceId: b,
      capName: 'battery',
      owner: 'other-9',
      mode: 'replace',
      fields: ['level'],
      values: {},
    })
    const listing = await h.deviceState.listClaims({ ownerPrefix: 'blk-' })
    expect(listing.state === 'loaded' && listing.claims.map((c) => c.deviceId)).toEqual([a])
  })
})

describe('the index and the seed (S6, ruling M)', () => {
  it('removeDevice prunes the index (i)', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })

    await h.provider.removeDevice({ deviceId: id })

    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
  })

  it('under a loaded index, a native write on an UNCLAIMED device reads no row on the RPC; the WRITER reads it once before the first row write (S6, D677)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = await setup(PROVIDERS)
      const a = await registerCamera(h, 'provider-hikvision', 'cam-a')
      const reads = h.settings.readDeviceRuntimeState
      const writes = h.settings.writeDeviceRuntimeState
      reads.mockClear()
      writes.mockClear()
      const readsOf = () => reads.mock.calls.filter(([id]) => id === a).length

      await Promise.all([
        h.setCapSlice(a, 'battery', NATIVE),
        h.setCapSlice(a, 'zones', { zones: [] }),
      ])
      expect(readsOf()).toBe(0) // the live path: claims known from the index
      expect(writes).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_100)
      expect(readsOf()).toBe(1) // single-flight, before the row write
      const firstWrite = writes.mock.invocationCallOrder[0] ?? 0
      expect(reads.mock.invocationCallOrder.at(-1) ?? Infinity).toBeLessThan(firstWrite)

      // Read once per process: a claim and a later native write do not re-read.
      await claim(h, a, ['level'], { level: 90 })
      await h.setCapSlice(a, 'battery', { ...NATIVE, level: 41 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(readsOf()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a native write whose row read FAILS still applies the slice and emits it; the row is written only after a read succeeds (D49, D677)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = await setup(PROVIDERS)
      const id = await registerCamera(h, 'provider-hikvision', 'cam-101')
      const DOORBELL = { pressCountSinceStart: 7, lastPressedAt: 1_790_000_000_000 }
      await h.settings.writeDeviceRuntimeState(id, { doorbell: DOORBELL })
      h.settings.writeDeviceRuntimeState.mockClear()
      const realRead = h.settings.readDeviceRuntimeState.getMockImplementation()
      h.settings.readDeviceRuntimeState.mockImplementation(async () => {
        throw new Error('sqlite busy')
      })

      const ZONES = { zones: [{ id: 'z1' }] }
      await h.setCapSlice(id, 'zones', ZONES)
      expect(await h.capSlice(id, 'zones')).toEqual(ZONES)
      expect(
        h.events.some(
          (e) =>
            e.category === EventCategory.DeviceStateChanged &&
            e.data['deviceId'] === id &&
            e.data['capName'] === 'zones',
        ),
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(4_000) // refused, re-armed with a backoff
      expect(h.settings.writeDeviceRuntimeState).not.toHaveBeenCalled()

      if (realRead) h.settings.readDeviceRuntimeState.mockImplementation(realRead)
      await vi.advanceTimersByTimeAsync(8_000)
      expect(h.settings.writeDeviceRuntimeState).toHaveBeenCalledTimes(1)
      expect(h.settings.writeDeviceRuntimeState.mock.calls[0]?.[1]).toEqual({
        doorbell: DOORBELL,
        zones: ZONES,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a foreign writer at hub boot (orchestrator zones) before the provider loads erases NOTHING from the stored row (D677)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = await setup(PROVIDERS)
      const id = await registerCamera(h, 'provider-hikvision', 'cam-101')
      // What the previous hub process left on the row: caps nobody re-writes
      // promptly after a restart (101's doorbell, a ~4 h day-night poll).
      const DOORBELL = { pressCountSinceStart: 7, lastPressedAt: 1_790_000_000_000 }
      const DAY_NIGHT = { mode: 'auto', lastFetchedAt: 1 }
      await h.settings.writeDeviceRuntimeState(id, { doorbell: DOORBELL, 'day-night': DAY_NIGHT })
      h.settings.writeDeviceRuntimeState.mockClear()

      // ~1 s after boot: the orchestrator hydrates zones, the index clears the device.
      const ZONES = { zones: [{ id: 'z1' }] }
      await h.setCapSlice(id, 'zones', ZONES)
      await vi.advanceTimersByTimeAsync(1_100) // the writer fires
      // ~2 s later the provider rebuilds the device and loads its state.
      await vi.advanceTimersByTimeAsync(2_000)
      const restored = await h.provider.loadRuntimeState({ deviceId: id })

      expect(restored).toEqual({ doorbell: DOORBELL, 'day-night': DAY_NIGHT, zones: ZONES })
      for (const [writtenId, row] of h.settings.writeDeviceRuntimeState.mock.calls) {
        if (writtenId !== id) continue
        expect(row).toMatchObject({ doorbell: DOORBELL, 'day-night': DAY_NIGHT })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('a native write on an already-seeded device does not even ask the index (final review M-1: no per-write view object)', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h) // the first write seeded it
    const view = vi.spyOn(FieldClaimsIndex.prototype, 'view')
    try {
      await h.setCapSlice(id, 'battery', { ...NATIVE, level: 41, lastUpdated: 2 })
      expect(view).not.toHaveBeenCalled()
      expect(await h.capSlice(id, 'battery')).toMatchObject({ level: 41 })
    } finally {
      view.mockRestore()
    }
  })

  it('getNativeCapSlice answers the shadow; getCapSlice answers the merge', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })
    await h.setCapSlice(id, 'battery', { ...NATIVE, level: 41 })

    expect(await h.deviceState.getCapSlice({ deviceId: id, capName: 'battery' })).toEqual({
      ...NATIVE,
      level: 90,
    })
    expect(await h.deviceState.getNativeCapSlice({ deviceId: id, capName: 'battery' })).toEqual({
      ...NATIVE,
      level: 41,
    })
  })

  it('a malformed index blob is UNKNOWN, never "no claims": the seed reads the row and the claim survives the next native write (I-2, D49)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // A valid entry followed by garbage — one dropped entry could be the very
      // device that is claimed, so the whole blob is unknown.
      const h = await setup({
        ...PROVIDERS,
        addonStoreSeed: {
          'field-claims-index': [
            {
              deviceId: 1,
              capName: 'battery',
              owner: 'x',
              mode: 'replace',
              fields: ['level'],
            },
            'garbage',
          ],
        },
      })
      const listing = await h.deviceState.listClaims({})
      expect(listing.state).toBe('not-loaded')
      if (listing.state === 'not-loaded') expect(listing.reason).toMatch(/malformed/)

      const id = await registerCamera(h, 'provider-hikvision', 'cam-a')
      // The row is the authority for $owned: a claim only it knows about.
      await h.settings.writeDeviceRuntimeState(id, {
        battery: NATIVE,
        [OWNED_FIELDS_KEY]: {
          battery: {
            owner: OWNER,
            mode: 'replace',
            fields: ['level'],
            values: { level: 90 },
          },
        },
      })
      const reads = h.settings.readDeviceRuntimeState
      reads.mockClear()

      await h.setCapSlice(id, 'battery', { ...NATIVE, level: 41 })
      expect(reads.mock.calls.filter(([d]) => d === id)).toHaveLength(1)
      expect(await h.capSlice(id, 'battery')).toEqual({ ...NATIVE, level: 90 })

      await vi.advanceTimersByTimeAsync(1_100)
      const lastRow = h.settings.writeDeviceRuntimeState.mock.calls.at(-1)?.[1]
      expect(lastRow?.[OWNED_FIELDS_KEY]).toEqual({
        battery: {
          owner: OWNER,
          mode: 'replace',
          fields: ['level'],
          values: { level: 90 },
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a competing claim is refused by the ROW before the index is touched: the index never names an owner the row refused (I-3)', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })
    const indexWrites = h.settings.writeAddonStore.mock.calls.length
    // Were the index written first, this would make the claim REJECT instead of refuse.
    h.settings.writeAddonStore.mockRejectedValueOnce(new Error('sqlite busy'))

    const other = await h.deviceState.claimFields({
      deviceId: id,
      capName: 'battery',
      owner: 'blk-2',
      mode: 'replace',
      fields: ['level'],
      values: {},
    })
    expect(other).toMatchObject({ ok: false, code: 'owned-by-other' })
    expect(h.settings.writeAddonStore.mock.calls.length).toBe(indexWrites)
    const listing = await h.deviceState.listClaims({})
    expect(listing.state === 'loaded' && listing.claims.map((c) => c.owner)).toEqual([OWNER])
    h.settings.writeAddonStore.mockReset()
    h.settings.writeAddonStore.mockImplementation(async () => undefined)
  })

  it('an index write that fails during removeDevice does not block the removal — it is logged, tagged, and the entry stays stale', async () => {
    const h = await setup(PROVIDERS)
    const id = await cameraWithBattery(h)
    await claim(h, id, ['level'], { level: 90 })
    h.settings.writeAddonStore.mockRejectedValueOnce(new Error('sqlite busy'))

    await expect(h.provider.removeDevice({ deviceId: id })).resolves.toBeUndefined()

    const warned = vi
      .mocked(h.logger.warn)
      .mock.calls.find(([msg]) => String(msg).includes('claims index not pruned'))
    expect(warned?.[1]).toMatchObject({ tags: { deviceId: id } })
    const listing = await h.deviceState.listClaims({})
    expect(listing.state === 'loaded' && listing.claims.map((c) => c.deviceId)).toEqual([id])
  })
})

describe('a device whose migration is in flight takes no claim, patch or release', () => {
  it('each answers migration-in-flight while the migration runs, and the claim lands once it is over', async () => {
    const h = await setup(PROVIDERS)
    const sourceId = await cameraWithBattery(h, 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const gate = h.gateNextSwitchWrite()
    const migration = h.provider.migrateDevice({ sourceId, targetId })
    await gate.reached

    const refusal = { ok: false, code: 'migration-in-flight' }
    expect(await claim(h, sourceId, ['level'], { level: 90 })).toMatchObject(refusal)
    expect(
      await h.deviceState.patchOwnedFields({
        deviceId: targetId,
        capName: 'battery',
        owner: OWNER,
        values: { level: 1 },
      }),
    ).toMatchObject(refusal)
    expect(
      await h.deviceState.releaseClaim({ deviceId: sourceId, capName: 'battery', owner: OWNER }),
    ).toMatchObject(refusal)
    const warned = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('migration'))
    expect(warned.length).toBeGreaterThanOrEqual(3)
    expect(await h.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })

    gate.release()
    await migration
    expect(await claim(h, sourceId, ['level'], { level: 90 })).toEqual({
      ok: true,
      changed: true,
    })
  })
})

describe('removeDevice forgets the device in the runtime-state mirror (D677, L3)', () => {
  it('a write armed before the removal never lands an orphan row after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = await setup(PROVIDERS)
      const id = await cameraWithBattery(h)
      await h.setCapSlice(id, 'zones', { zones: [{ id: 'z1' }] }) // arms the 1 s writer
      await h.provider.removeDevice({ deviceId: id })
      h.settings.writeDeviceRuntimeState.mockClear()

      await vi.advanceTimersByTimeAsync(5_000)

      expect(h.settings.writeDeviceRuntimeState).not.toHaveBeenCalled()
      expect(await h.settings.readDeviceRuntimeState(id)).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})
