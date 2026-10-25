/**
 * `DeviceStateMirror` under per-field claims (D663): the native shadow, the
 * merged view, claims atomic with the row, and the index-first single-flight
 * seed. Runs the PRODUCTION policy (`battery` is restored, `lastUpdated`
 * volatile; `audio-metrics` is session-only).
 *
 * The first describe is the contract every device on the live hub relies on:
 * a device with NO claims must behave exactly as before this module existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventCategory, runtimeStatePolicyFor } from '@camstack/types'
import { loadRuntimeState } from '../device-meta-actions.js'
import type { ProviderContext } from '../device-provider-context.js'
import { OWNED_FIELDS_KEY } from '../field-ownership.js'
import { flushDebounce, harness, loadedIndex, NOT_LOADED_INDEX } from './mirror-harness.js'

const realPolicy = runtimeStatePolicyFor
const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED = {
  owner: 'blk-1',
  mode: 'replace' as const,
  fields: ['percentage'],
  values: { percentage: 90 },
}
const REFUSAL = 'runtime-state row unreadable'
/** A whole `audio-metrics` slice (session-only): an `add` claim must build a slice its schema accepts. */
const AUDIO = {
  ts: 1,
  windowSec: 60,
  level: { rms: 0.01, dbfs: -30 },
  peakDbfs: -20,
  avgDbfs: -30,
  current: null,
  byClass: [],
}
const AUDIO_FIELDS = Object.keys(AUDIO)
const AUDIO_ADD = { owner: 'blk-1', mode: 'add' as const, fields: AUDIO_FIELDS, values: AUDIO }

describe('a device with NO claims behaves exactly as before (the live-hub contract)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('same mirror, same events, same row — and no $owned key anywhere', async () => {
    const h = harness(realPolicy)
    // The boot seed, then the provider's first write after it.
    h.mirror.seedMirror(101, { battery: NATIVE, 'audio-metrics': { avgDbfs: -39 } })
    expect(h.mirror.isSeeded(101)).toBe(true)
    expect(h.events).toEqual([])
    await h.mirror.ensureSeeded(101, h.settings, NOT_LOADED_INDEX) // already seeded: no read
    expect(h.mirror.applySingleCapUpdate(101, 'battery', NATIVE)).toBe(false) // identical: no emit
    expect(h.mirror.applySingleCapUpdate(101, 'battery', { ...NATIVE, percentage: 41 })).toBe(true)
    h.mirror.applySingleCapUpdate(101, 'audio-metrics', { avgDbfs: -40 })
    h.mirror.scheduleRuntimeStateDiskWrite(101, h.settings, 'battery')
    await flushDebounce()

    expect(h.events).toEqual([
      { capName: 'battery', slice: { ...NATIVE, percentage: 41 } },
      { capName: 'audio-metrics', slice: { avgDbfs: -40 } },
    ])
    expect(h.events.every((e) => !('native' in e))).toBe(true)
    expect(h.shadows).toEqual([])
    expect(new Set(h.categories)).toEqual(new Set([EventCategory.DeviceStateChanged]))
    expect(h.mirror.snapshotForDevice(101)).toEqual({
      battery: { ...NATIVE, percentage: 41 },
      'audio-metrics': { avgDbfs: -40 },
    })
    expect(h.mirror.capSlice(101, 'battery')).toEqual({ ...NATIVE, percentage: 41 })
    expect(h.mirror.capSlice(101, 'never-written')).toBeNull()
    expect(h.mirror.allSnapshots()).toEqual({ '101': h.mirror.snapshotForDevice(101) })
    expect(h.mirror.ownedCaps(101).size).toBe(0)
    expect(h.mirror.effectiveIfClaimed(101, 'battery')).toBeNull()
    expect(h.writes).toEqual([{ deviceId: 101, blob: { battery: { ...NATIVE, percentage: 41 } } }])
    expect(h.writes[0]?.blob).not.toHaveProperty(OWNED_FIELDS_KEY)
    expect(h.logs).toEqual([])
  })

  it('a first write that precedes the boot seed reads the row once and applies over it', async () => {
    const h = harness(realPolicy)
    h.rows.set(101, { battery: NATIVE })
    const reads = vi.spyOn(h.settings, 'readDeviceRuntimeState')
    await h.mirror.ensureSeeded(101, h.settings, NOT_LOADED_INDEX)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(h.mirror.applySingleCapUpdate(101, 'battery', { ...NATIVE, percentage: 41 })).toBe(true)
    expect(h.events).toEqual([{ capName: 'battery', slice: { ...NATIVE, percentage: 41 } }])
    expect(h.mirror.snapshotForDevice(101)).toEqual({ battery: { ...NATIVE, percentage: 41 } })
    await h.mirror.ensureSeeded(101, h.settings, NOT_LOADED_INDEX)
    expect(reads).toHaveBeenCalledTimes(1)
  })
})

describe('DeviceStateMirror — per-field claims (D663)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a native write under a replace claim emits the MERGED slice and carries native', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const c = await h.mirror.claim(7, 'battery', OWNED, h.settings)
    expect(c).toEqual({ ok: true, changed: true })
    expect(h.shadows).toEqual([]) // a claim moves no native: nothing for the owner yet
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    expect(h.events.at(-1)).toEqual({ capName: 'battery', slice: { ...NATIVE, percentage: 90 } })
    expect(h.shadows).toEqual([{ capName: 'battery', native: { ...NATIVE, percentage: 41 } }])
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
    expect(h.mirror.nativeSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 41 })
    expect(h.mirror.snapshotForDevice(7)).toEqual({ battery: { ...NATIVE, percentage: 90 } })
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toEqual({
      kind: 'slice',
      slice: { ...NATIVE, percentage: 90 },
    })
  })

  it('the native provider writing again never overwrites an owned field', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    for (const percentage of [10, 20, 30]) {
      h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage })
      expect(h.mirror.capSlice(7, 'battery')?.percentage).toBe(90)
      expect(h.events.at(-1)?.slice.percentage).toBe(90)
    }
    expect(h.mirror.nativeSlice(7, 'battery')?.percentage).toBe(30)
  })

  it('a claimed field the composer has not written yet is HELD — the event stream never shows the native value for it (S5)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const c = await h.mirror.claim(
      7,
      'battery',
      { ...OWNED, fields: ['percentage', 'charging'], values: { percentage: 90 } },
      h.settings,
    )
    expect(c).toEqual({ ok: true, changed: true })
    expect(h.mirror.capSlice(7, 'battery')).toBeNull()
    expect(h.mirror.snapshotForDevice(7)).toEqual({})
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toEqual({
      kind: 'held',
      reason: 'claimed fields with no value yet: charging',
    })
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    expect(h.events.filter((e) => e.capName === 'battery')).toEqual([])
    // The owner still learns the native, held or not — its derived field depends on it.
    expect(h.shadows).toEqual([{ capName: 'battery', native: { ...NATIVE, percentage: 41 } }])
    const held = h.logs.filter((l) => l.message.includes('held'))
    expect(held).toHaveLength(1)
    expect(held[0]?.extras).toMatchObject({ tags: { deviceId: 7 } })

    const p = await h.mirror.patchOwned(7, 'battery', 'blk-1', { charging: 'unknown' }, h.settings)
    expect(p).toEqual({ ok: true, changed: true })
    expect(h.events.at(-1)).toEqual({
      capName: 'battery',
      slice: { ...NATIVE, percentage: 90, charging: 'unknown' },
    })
  })

  it('a replace claim over a cap with no native slice yet is HELD until the native arrives', async () => {
    const h = harness(realPolicy)
    await h.mirror.ensureSeeded(7, h.settings, loadedIndex([]))
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    expect(h.mirror.capSlice(7, 'battery')).toBeNull()
    expect(h.events).toEqual([])
    h.mirror.applySingleCapUpdate(7, 'battery', NATIVE)
    expect(h.events).toEqual([{ capName: 'battery', slice: { ...NATIVE, percentage: 90 } }])
    expect(h.shadows).toEqual([{ capName: 'battery', native: NATIVE }])
  })

  it('a merge the schema refuses is HELD and the last good merged slice stays readable; one warn per transition', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    await h.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 900 }, h.settings)
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toMatchObject({ kind: 'held' })
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    expect(h.events.filter((e) => e.capName === 'battery')).toHaveLength(1) // only the claim's emit
    const warns = h.logs.filter((l) => l.level === 'warn' && l.message.includes('held'))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({ tags: { deviceId: 7 } })
    expect(JSON.stringify(warns[0]?.extras)).toContain('percentage')
  })

  it('release emits the native slice EXACTLY (deep-equal to the last native write)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    const r = await h.mirror.release(7, 'battery', 'blk-1', h.settings)
    expect(r).toEqual({ ok: true, changed: true })
    expect(h.events.at(-1)).toEqual({ capName: 'battery', slice: { ...NATIVE, percentage: 41 } })
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 41 })
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toBeNull()
    expect(h.writes.at(-1)?.blob).toEqual({ battery: { ...NATIVE, percentage: 41 } })
  })

  it('release of an add claim removes the cap and emits nothing', async () => {
    const h = harness(realPolicy)
    await h.mirror.ensureSeeded(7, h.settings, loadedIndex([]))
    await h.mirror.claim(7, 'audio-metrics', AUDIO_ADD, h.settings)
    expect(h.mirror.capSlice(7, 'audio-metrics')).toEqual(AUDIO)
    expect(h.events.at(-1)).toEqual({ capName: 'audio-metrics', slice: AUDIO }) // no native under add
    const before = h.events.length
    await h.mirror.release(7, 'audio-metrics', 'blk-1', h.settings)
    expect(h.events).toHaveLength(before)
    expect(h.mirror.capSlice(7, 'audio-metrics')).toBeNull()
    expect(h.mirror.snapshotForDevice(7)).toEqual({})
  })

  it('claim by another owner is refused owned-by-other; a patch naming a field outside `fields` is field-not-claimed', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    expect(
      await h.mirror.claim(7, 'battery', { ...OWNED, owner: 'blk-2' }, h.settings),
    ).toMatchObject({ ok: false, code: 'owned-by-other' })
    expect(
      await h.mirror.patchOwned(7, 'battery', 'blk-2', { percentage: 1 }, h.settings),
    ).toMatchObject({ ok: false, code: 'owned-by-other' })
    expect(
      await h.mirror.patchOwned(7, 'battery', 'blk-1', { charging: 'dc' }, h.settings),
    ).toMatchObject({ ok: false, code: 'field-not-claimed' })
    expect(await h.mirror.patchOwned(7, 'zones', 'blk-1', { zones: [] }, h.settings)).toMatchObject(
      {
        ok: false,
        code: 'not-claimed',
      },
    )
    expect(await h.mirror.release(7, 'battery', 'blk-2', h.settings)).toMatchObject({
      ok: false,
      code: 'owned-by-other',
    })
    expect(await h.mirror.release(7, 'zones', 'blk-1', h.settings)).toMatchObject({
      ok: false,
      code: 'not-claimed',
    })
    // Nothing above changed the claim.
    expect(h.mirror.ownedCaps(7).get('battery')).toEqual(OWNED)
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
  })

  it('claim resolves only after the row write landed (write-through)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.settings.writeDeviceRuntimeState.bind(h.settings)
    vi.spyOn(h.settings, 'writeDeviceRuntimeState').mockImplementation(async (id, blob) => {
      await gate
      await original(id, blob)
    })
    let settled = false
    const pending = h.mirror.claim(7, 'battery', OWNED, h.settings).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBe(false)
    expect(h.writes).toEqual([])
    release!()
    expect(await pending).toEqual({ ok: true, changed: true })
    expect(h.writes).toEqual([
      { deviceId: 7, blob: { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } } },
    ])
  })

  it('a patch follows the debounce and the effective-change gate; a repeated value costs no commit', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    expect(h.writes).toHaveLength(1)
    await h.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 91 }, h.settings)
    expect(h.writes).toHaveLength(1) // not yet: debounced
    await flushDebounce()
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]?.blob[OWNED_FIELDS_KEY]).toEqual({
      battery: { ...OWNED, values: { percentage: 91 } },
    })
    expect(
      await h.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 91 }, h.settings),
    ).toEqual({ ok: true, changed: false })
    await flushDebounce()
    expect(h.writes).toHaveLength(2)
  })

  it('a session-only cap keeps its claim on the row but not its values; after a restart the fields are HELD until the composer writes (rule 5)', async () => {
    const h = harness(realPolicy)
    await h.mirror.ensureSeeded(7, h.settings, loadedIndex([]))
    await h.mirror.claim(7, 'audio-metrics', AUDIO_ADD, h.settings)
    expect(h.mirror.capSlice(7, 'audio-metrics')).toEqual(AUDIO)
    const row = h.writes.at(-1)?.blob ?? {}
    expect(row).toEqual({
      [OWNED_FIELDS_KEY]: {
        'audio-metrics': { owner: 'blk-1', mode: 'add', fields: AUDIO_FIELDS, values: {} },
      },
    })
    const after = harness(realPolicy)
    after.mirror.seedMirror(7, row)
    expect(after.mirror.capSlice(7, 'audio-metrics')).toBeNull()
    expect(after.mirror.effectiveIfClaimed(7, 'audio-metrics')).toEqual({
      kind: 'held',
      reason: `claimed fields with no value yet: ${AUDIO_FIELDS.join(', ')}`,
    })
  })

  it('seedMirror never overwrites a slice already in memory, and an in-memory claim wins over the disk copy (S6)', async () => {
    const h = harness(realPolicy)
    await h.mirror.ensureSeeded(7, h.settings, loadedIndex([]))
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 55 })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    h.mirror.seedMirror(7, {
      battery: NATIVE,
      zones: { zones: [] },
      [OWNED_FIELDS_KEY]: { battery: { ...OWNED, owner: 'blk-stale', values: { percentage: 1 } } },
    })
    expect(h.mirror.nativeSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 55 })
    expect(h.mirror.nativeSlice(7, 'zones')).toEqual({ zones: [] }) // a gap is filled
    expect(h.mirror.ownedCaps(7).get('battery')).toEqual(OWNED)
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
  })

  it('a malformed $owned entry on the row is dropped by name and logged once with tags.deviceId', () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: { owner: 3 } } })
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
    const dropped = h.logs.filter((l) => l.level === 'warn')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.extras).toMatchObject({ tags: { deviceId: 7 }, meta: { caps: ['battery'] } })
  })

  it('the disk row holds NATIVE slices; loadRuntimeState hands the worker no $owned', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    const row = h.writes.at(-1)?.blob ?? {}
    expect(row).toEqual({ battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } })

    const restarted = harness(realPolicy)
    const pctx = {
      metaStore: { resolvePersistedById: async () => ({ id: 7 }) },
      settings: { readDeviceRuntimeState: async () => row },
      host: {
        seedMirror: (id: number, blob: Record<string, unknown>) =>
          restarted.mirror.seedMirror(id, blob),
        withResetSessionProbe: (blob: Record<string, unknown>) =>
          restarted.mirror.withResetSessionProbe(blob),
      },
    } as unknown as ProviderContext
    const initial = await loadRuntimeState(pctx, { deviceId: 7 })
    expect(initial).toEqual({ battery: NATIVE })
    expect(initial).not.toHaveProperty(OWNED_FIELDS_KEY)
    // …while the mirror got both halves, and serves the merged view.
    expect(restarted.mirror.ownedCaps(7).get('battery')).toEqual(OWNED)
    expect(restarted.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
  })

  it('ensureSeeded on a device the LOADED index does not name knows its CLAIMS without a read — and that never licenses a row write (S6, D447, D677)', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(realPolicy)
      // A NON-empty row: with `{}` here, "did not read" and "read and found
      // nothing" are the same row, which is how this test once vouched for the
      // write that erased every restored cap of a camera at hub boot.
      const DOORBELL = { pressCountSinceStart: 7, lastPressedAt: 1_790_000_000_000 }
      h.rows.set(7, { battery: NATIVE, doorbell: DOORBELL })
      const reads = vi.spyOn(h.settings, 'readDeviceRuntimeState')

      await h.mirror.ensureSeeded(7, h.settings, loadedIndex([]))
      expect(reads).not.toHaveBeenCalled() // the READ path: claims known, no row read
      expect(h.mirror.isSeeded(7)).toBe(true)
      expect(h.mirror.isRowRead(7)).toBe(false)

      // A foreign writer lands a slice; the writer reads the row BEFORE writing.
      const ZONES = { zones: [{ id: 'z1' }] }
      h.mirror.applySingleCapUpdate(7, 'zones', ZONES)
      h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'zones')
      await flushDebounce()

      expect(reads).toHaveBeenCalledTimes(1)
      expect(h.writes).toEqual([
        { deviceId: 7, blob: { battery: NATIVE, doorbell: DOORBELL, zones: ZONES } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ensureSeeded on a device the index names, or under a not-loaded index, reads the row ONCE for N concurrent writes (S6)', async () => {
    const h = harness(realPolicy)
    h.rows.set(7, { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } })
    const reads = vi.spyOn(h.settings, 'readDeviceRuntimeState')
    await Promise.all([
      h.mirror.ensureSeeded(7, h.settings, loadedIndex([7])),
      h.mirror.ensureSeeded(7, h.settings, loadedIndex([7])),
      h.mirror.ensureSeeded(7, h.settings, NOT_LOADED_INDEX),
    ])
    expect(reads).toHaveBeenCalledTimes(1)
    expect(h.mirror.isSeeded(7)).toBe(true)
    expect(h.mirror.ownedCaps(7).get('battery')).toEqual(OWNED)
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
    expect(h.events).toEqual([]) // a seed is population, not a transition
  })

  it('ensureSeeded whose row read FAILS throws, changes nothing, and logs once with tags.deviceId (S6, D49, D391)', async () => {
    const h = harness(realPolicy)
    h.failReads.add(7)
    await expect(h.mirror.ensureSeeded(7, h.settings, NOT_LOADED_INDEX)).rejects.toThrow(
      'sqlite busy',
    )
    expect(h.mirror.isSeeded(7)).toBe(false)
    expect(h.mirror.snapshotForDevice(7)).toEqual({})
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.events).toEqual([])
    const refusals = h.logs.filter((l) => l.message.startsWith(REFUSAL))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.extras).toMatchObject({
      tags: { deviceId: 7 },
      meta: { error: 'sqlite busy' },
    })
    await expect(h.mirror.ensureSeeded(7, h.settings, NOT_LOADED_INDEX)).rejects.toThrow()
    expect(h.logs.filter((l) => l.message.startsWith(REFUSAL))).toHaveLength(1) // once per transition

    // The read comes back: the seed lands, and the NEXT failure logs again.
    h.failReads.delete(7)
    h.rows.set(7, { battery: NATIVE })
    await h.mirror.ensureSeeded(7, h.settings, NOT_LOADED_INDEX)
    expect(h.mirror.isSeeded(7)).toBe(true)
    expect(h.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
  })

  it('a re-claim that NARROWS `fields` hands the dropped fields back to the native; an empty set is refused (rule 11, S1b)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(
      7,
      'battery',
      {
        ...OWNED,
        fields: ['percentage', 'charging'],
        values: { percentage: 90, charging: 'unknown' },
      },
      h.settings,
    )
    expect(h.events.at(-1)?.slice).toEqual({ ...NATIVE, percentage: 90, charging: 'unknown' })

    const narrowed = await h.mirror.claim(
      7,
      'battery',
      { ...OWNED, fields: ['percentage'], values: {} },
      h.settings,
    )
    expect(narrowed).toEqual({ ok: true, changed: true })
    expect(h.events.at(-1)).toEqual({ capName: 'battery', slice: { ...NATIVE, percentage: 90 } })
    expect(h.mirror.ownedCaps(7).get('battery')?.values).toEqual({ percentage: 90 })
    expect(h.mirror.ownedCaps(7).get('battery')?.fields).toEqual(['percentage'])
    expect(h.writes.at(-1)?.blob[OWNED_FIELDS_KEY]).toEqual({
      battery: { ...OWNED, fields: ['percentage'], values: { percentage: 90 } },
    })

    const writesBefore = h.writes.length
    const eventsBefore = h.events.length
    expect(
      await h.mirror.claim(7, 'battery', { ...OWNED, fields: [], values: {} }, h.settings),
    ).toMatchObject({ ok: false, code: 'invalid-slice' })
    expect(h.writes).toHaveLength(writesBefore)
    expect(h.events).toHaveLength(eventsBefore)
    expect(h.mirror.ownedCaps(7).get('battery')?.fields).toEqual(['percentage'])
  })

  it('a re-claim of a restored doorbell keeps lastPressedAt the row already holds', async () => {
    const h = harness(realPolicy)
    const native = { lastPressedAt: 1_727_600_000_000, pressCountSinceStart: 1 }
    const claimed = { lastPressedAt: 1_761_300_000_000, pressCountSinceStart: 4 }
    h.mirror.seedMirror(101, { doorbell: native })
    await h.mirror.claim(
      101,
      'doorbell',
      {
        owner: 'blk-doorbell',
        mode: 'add',
        fields: ['lastPressedAt', 'pressCountSinceStart'],
        values: claimed,
      },
      h.settings,
    )
    const again = await h.mirror.claim(
      101,
      'doorbell',
      {
        owner: 'blk-doorbell',
        mode: 'add',
        fields: ['lastPressedAt', 'pressCountSinceStart'],
        values: {},
      },
      h.settings,
    )
    expect(again).toEqual({ ok: true, changed: false })
    expect(h.mirror.ownedCaps(101).get('doorbell')?.values).toEqual(claimed)
    expect(h.mirror.capSlice(101, 'doorbell')).toEqual(claimed)
  })

  it('a claim carrying a value for a field it does not claim is refused field-not-claimed', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    expect(
      await h.mirror.claim(
        7,
        'battery',
        { ...OWNED, values: { percentage: 90, charging: 'dc' } },
        h.settings,
      ),
    ).toMatchObject({ ok: false, code: 'field-not-claimed' })
    expect(h.mirror.ownedCaps(7).size).toBe(0)
  })

  it('the native shadow NEVER rides the public event: it travels on its own category, only under a replace claim, only when the native moves (D224)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    await h.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 91 }, h.settings)
    expect(h.shadows).toEqual([]) // owned writes move no native
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 42 })
    expect(h.shadows).toEqual([
      { capName: 'battery', native: { ...NATIVE, percentage: 41 } },
      { capName: 'battery', native: { ...NATIVE, percentage: 42 } },
    ])
    expect(h.events.every((e) => !('native' in e))).toBe(true)
    // An `add` claim has no native to shadow, even when the device also writes the cap.
    await h.mirror.claim(7, 'audio-metrics', AUDIO_ADD, h.settings)
    h.mirror.applySingleCapUpdate(7, 'audio-metrics', { ...AUDIO, ts: 2 })
    expect(h.shadows.filter((sh) => sh.capName === 'audio-metrics')).toEqual([])
    expect(new Set(h.categories)).toEqual(
      new Set([EventCategory.DeviceStateChanged, EventCategory.DeviceNativeShadowChanged]),
    )
  })

  it('seedMirror in `replace` mode makes the mirror answer exactly the blob — the migration reseed (I-1)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: { ...NATIVE, percentage: 55 }, zones: { zones: [] } })
    await h.mirror.claim(7, 'battery', OWNED, h.settings)
    const swappedRow = { battery: NATIVE, 'device-status': { online: true, lastChangedAt: 1 } }
    h.mirror.seedMirror(7, swappedRow, 'replace')
    expect(h.mirror.snapshotForDevice(7)).toEqual(swappedRow)
    expect(h.mirror.capSlice(7, 'zones')).toBeNull()
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toBeNull()
    expect(h.mirror.isSeeded(7)).toBe(true)
    // …and the default stays fill-gaps for the boot path.
    h.mirror.seedMirror(7, { battery: { ...NATIVE, percentage: 1 } })
    expect(h.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
  })

  it('a re-seed never makes a pending debounced write look persisted — the newer value lands (I-2)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, percentage: 41 })
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'battery')
    // A worker restart re-loads the row while the write is still in its window.
    h.mirror.seedMirror(7, { battery: NATIVE })
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 41 }) // memory kept
    await flushDebounce()
    expect(h.writes).toEqual([{ deviceId: 7, blob: { battery: { ...NATIVE, percentage: 41 } } }])
  })

  it('a claim that so far exists only on the row is found by patchOwned and release — no zombie (I-3)', async () => {
    const patched = harness(realPolicy)
    patched.rows.set(7, { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } })
    expect(
      await patched.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 80 }, patched.settings),
    ).toEqual({ ok: true, changed: true })
    expect(patched.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 80 })

    const released = harness(realPolicy)
    released.rows.set(7, { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } })
    expect(await released.mirror.release(7, 'battery', 'blk-1', released.settings)).toEqual({
      ok: true,
      changed: true,
    })
    expect(released.mirror.ownedCaps(7).size).toBe(0)
    expect(released.writes.at(-1)?.blob).toEqual({ battery: NATIVE })
    expect(released.writes.at(-1)?.blob).not.toHaveProperty(OWNED_FIELDS_KEY)
    expect(released.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
  })

  it('a failed write-through rolls memory back, logs with tags.deviceId, and the re-claim really writes (I-4)', async () => {
    const h = harness(realPolicy)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const write = vi.spyOn(h.settings, 'writeDeviceRuntimeState')
    write.mockRejectedValueOnce(new Error('disk full'))
    await expect(h.mirror.claim(7, 'battery', OWNED, h.settings)).rejects.toThrow('disk full')
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.mirror.effectiveIfClaimed(7, 'battery')).toBeNull()
    expect(h.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
    const warns = h.logs.filter((l) => l.message.startsWith('claim write-through failed'))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({
      tags: { deviceId: 7 },
      meta: { cap: 'battery', owner: 'blk-1', error: 'disk full' },
    })
    // Consumers are handed the truth that stands: the native.
    expect(h.events.at(-1)).toEqual({ capName: 'battery', slice: NATIVE })
    // S5 recovery: the composer re-sends the CLAIM, and it is a real write.
    expect(await h.mirror.claim(7, 'battery', OWNED, h.settings)).toEqual({
      ok: true,
      changed: true,
    })
    expect(h.writes).toEqual([
      { deviceId: 7, blob: { battery: NATIVE, [OWNED_FIELDS_KEY]: { battery: OWNED } } },
    ])
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })

    // The same for a release: the claim stays until the row says otherwise.
    write.mockRejectedValueOnce(new Error('disk full'))
    await expect(h.mirror.release(7, 'battery', 'blk-1', h.settings)).rejects.toThrow('disk full')
    expect(h.mirror.ownedCaps(7).get('battery')).toEqual(OWNED)
    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, percentage: 90 })
    expect(h.logs.filter((l) => l.message.startsWith('release write-through failed'))).toHaveLength(
      1,
    )
    expect(await h.mirror.release(7, 'battery', 'blk-1', h.settings)).toEqual({
      ok: true,
      changed: true,
    })
    expect(h.writes.at(-1)?.blob).toEqual({ battery: NATIVE })
  })

  it('an unreadable row is a NAMED refusal for claim, patchOwned and release — unknown, never "gone" (M-8, D49)', async () => {
    const h = harness(realPolicy)
    h.failReads.add(7)
    const outcomes = [
      await h.mirror.claim(7, 'battery', OWNED, h.settings),
      await h.mirror.patchOwned(7, 'battery', 'blk-1', { percentage: 1 }, h.settings),
      await h.mirror.release(7, 'battery', 'blk-1', h.settings),
    ]
    for (const o of outcomes) expect(o).toMatchObject({ ok: false, code: 'row-unreadable' })
    expect(h.mirror.ownedCaps(7).size).toBe(0)
    expect(h.mirror.snapshotForDevice(7)).toEqual({})
    expect(h.writes).toEqual([])
    expect(h.events).toEqual([])
    expect(h.logs.filter((l) => l.message.startsWith(REFUSAL))).toHaveLength(1) // once per transition
  })
})
