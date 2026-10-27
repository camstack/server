/**
 * The write-through WINDOW of a claim or release (D663 re-review N-4, N-5).
 *
 * A claim is written through: memory changes first, the row write is awaited,
 * and only then does the method return. What happens INSIDE that await used to
 * be unguarded:
 *
 *  - N-5: readers saw the NATIVE for a field that was already claimed — the
 *    merged view was computed only after the write landed. S5 says a claimed
 *    field with no value is HELD, never answered from the native; a claim with
 *    a value is answered with it, from the moment it is accepted.
 *  - N-4 (D49): the rollback of a failed write was unconditional. A same-owner
 *    patch that landed in the window was erased with the claim, the debounce
 *    then PERSISTED the rolled-back row, and the owner had been told the patch
 *    landed. And two row writes for one device could be in flight at once —
 *    the write-through bypassed the debounce writer's `inFlight` serialisation.
 *
 * Every write here is a deferred promise the test settles by hand, so each
 * interleaving is exact. Neutralisation: make the rollback unconditional (or
 * recompute with the LOCAL claim), drop the pre-await view, or let the
 * write-through skip the queue — the named test goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeStatePolicyFor } from '@camstack/types'
import { isPlainRecord, OWNED_FIELDS_KEY } from '../field-ownership.js'
import { flushDebounce, harness, type Harness } from './mirror-harness.js'

const NATIVE = { level: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const CLAIM = {
  owner: 'blk-1',
  mode: 'replace' as const,
  fields: ['level'],
  values: { level: 90 },
}

interface Deferred {
  resolve: () => void
  reject: (err: Error) => void
}

/** Park the NEXT `writeDeviceRuntimeState` until the test settles it. */
function deferNextWrite(h: Harness): Deferred {
  const d: Deferred = { resolve: () => undefined, reject: () => undefined }
  const gate = new Promise<void>((resolve, reject) => {
    d.resolve = resolve
    d.reject = reject
  })
  const real = h.settings.writeDeviceRuntimeState.bind(h.settings)
  vi.spyOn(h.settings, 'writeDeviceRuntimeState').mockImplementationOnce(async (id, blob) => {
    await gate
    await real(id, blob)
  })
  return d
}

/** Let the microtasks behind a settled gate run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function ownedOnRow(blob: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  const owned = blob[OWNED_FIELDS_KEY]
  return isPlainRecord(owned) ? owned : undefined
}

describe('N-5 — readers see the claim from the moment it is accepted', () => {
  it('a valued claim answers the MERGE during its write, never the native', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await settle()

    expect(h.mirror.capSlice(7, 'battery')).toEqual({ ...NATIVE, level: 90 })
    expect(h.mirror.snapshotForDevice(7)).toEqual({ battery: { ...NATIVE, level: 90 } })
    // Nothing is EMITTED until the row has it — the event is the durable truth.
    expect(h.events).toEqual([])

    gate.resolve()
    expect(await pending).toEqual({ ok: true, changed: true })
    expect(h.events).toEqual([{ capName: 'battery', slice: { ...NATIVE, level: 90 } }])
  })

  it('a claim with a valueless field HOLDS the cap during its write (S5)', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(
      7,
      'battery',
      { ...CLAIM, fields: ['level', 'charging'] },
      h.settings,
    )
    await settle()

    expect(h.mirror.capSlice(7, 'battery')).toBeNull()
    expect(h.mirror.snapshotForDevice(7)).toEqual({})

    gate.resolve()
    await pending
    expect(h.mirror.capSlice(7, 'battery')).toBeNull()
    expect(h.events).toEqual([])
  })

  it('a failed write puts the native back for readers', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await settle()
    expect(h.mirror.capSlice(7, 'battery')?.level).toBe(90)

    gate.reject(new Error('sqlite busy'))
    await expect(pending).rejects.toThrow('sqlite busy')
    expect(h.mirror.capSlice(7, 'battery')).toEqual(NATIVE)
    expect(h.mirror.ownedCaps(7).size).toBe(0)
  })
})

describe('N-4 — a same-owner patch in the window survives the claim write, either way', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('claim write FAILS after the patch landed: the patch stands, the claim rejects, the row converges to the PATCHED claim', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await vi.advanceTimersByTimeAsync(0)

    const patch = await h.mirror.patchOwned(7, 'battery', 'blk-1', { level: 95 }, h.settings)
    expect(patch).toEqual({ ok: true, changed: true })

    gate.reject(new Error('sqlite busy'))
    await expect(pending).rejects.toThrow('sqlite busy')

    // Not erased: the owner was told the patch landed, and it did.
    expect(h.mirror.ownedCaps(7).get('battery')?.values).toEqual({ level: 95 })
    expect(h.mirror.capSlice(7, 'battery')?.level).toBe(95)
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('newer'))).toBe(true)

    await flushDebounce()
    const last = h.writes.at(-1)
    expect(last?.deviceId).toBe(7)
    expect(ownedOnRow(last?.blob ?? {})).toEqual({
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['level'],
        values: { level: 95 },
      },
    })
    // And what was rolled back is never what gets persisted: no write carries 90.
    expect(h.writes.some((w) => JSON.stringify(ownedOnRow(w.blob)).includes('"level":90'))).toBe(
      false,
    )
  })

  it('claim write LANDS after the patch: the emitted view is the PATCHED merge, not the claim-local one', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await vi.advanceTimersByTimeAsync(0)
    await h.mirror.patchOwned(7, 'battery', 'blk-1', { level: 95 }, h.settings)

    gate.resolve()
    await pending

    expect(h.events.at(-1)).toEqual({ capName: 'battery', slice: { ...NATIVE, level: 95 } })
    expect(h.events.some((e) => e.slice.level === 90)).toBe(false)
    expect(h.mirror.capSlice(7, 'battery')?.level).toBe(95)
    await flushDebounce()
    expect(ownedOnRow(h.writes.at(-1)?.blob ?? {})).toEqual({
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['level'],
        values: { level: 95 },
      },
    })
  })

  it('after a failed claim whose patched successor stands, a repeat claim is a REAL write (I-4 kept)', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await vi.advanceTimersByTimeAsync(0)
    await h.mirror.patchOwned(7, 'battery', 'blk-1', { level: 95 }, h.settings)
    gate.reject(new Error('sqlite busy'))
    await expect(pending).rejects.toThrow()
    const writes = h.writes.length

    // The claim exactly as memory holds it, before the debounce has converged
    // the row: the row does not carry it, so this is a write — never `changed: false`.
    const again = await h.mirror.claim(
      7,
      'battery',
      { ...CLAIM, values: { level: 95 } },
      h.settings,
    )
    expect(again).toEqual({ ok: true, changed: true })
    expect(h.writes.length).toBe(writes + 1)
    expect(ownedOnRow(h.writes.at(-1)?.blob ?? {})).toEqual({
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['level'],
        values: { level: 95 },
      },
    })
  })

  it('a release whose write fails does not resurrect the old claim over a re-claim made in its window', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    await h.mirror.claim(7, 'battery', CLAIM, h.settings)
    const gate = deferNextWrite(h)
    const releasing = h.mirror.release(7, 'battery', 'blk-1', h.settings)
    await vi.advanceTimersByTimeAsync(0)

    const wider = {
      ...CLAIM,
      fields: ['level', 'charging'],
      values: { level: 1, charging: 'dc' },
    }
    const reclaim = h.mirror.claim(7, 'battery', wider, h.settings)
    await vi.advanceTimersByTimeAsync(0)

    gate.reject(new Error('sqlite busy'))
    await expect(releasing).rejects.toThrow('sqlite busy')
    expect(await reclaim).toEqual({ ok: true, changed: true })

    expect(h.mirror.ownedCaps(7).get('battery')).toEqual(wider)
    expect(ownedOnRow(h.writes.at(-1)?.blob ?? {})).toEqual({
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['level', 'charging'],
        values: wider.values,
      },
    })
  })
})

describe('N-4 — one row write in flight per device', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a second write-through waits for the first; the second row carries both claims', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE, zones: { zones: [] } })
    const gate = deferNextWrite(h)
    const writes = vi.spyOn(h.settings, 'writeDeviceRuntimeState')
    const first = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await vi.advanceTimersByTimeAsync(0)
    const second = h.mirror.claim(
      7,
      'zones',
      { owner: 'blk-2', mode: 'replace', fields: ['zones'], values: { zones: [] } },
      h.settings,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveBeenCalledTimes(1)

    gate.resolve()
    await first
    await second
    expect(writes).toHaveBeenCalledTimes(2)
    expect(Object.keys(ownedOnRow(h.writes.at(-1)?.blob ?? {}) ?? {}).toSorted()).toEqual([
      'battery',
      'zones',
    ])
  })

  it('a debounced native write fired inside a write-through window lands AFTER it, with the claim', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(7, { battery: NATIVE })
    const gate = deferNextWrite(h)
    const writes = vi.spyOn(h.settings, 'writeDeviceRuntimeState')
    const pending = h.mirror.claim(7, 'battery', CLAIM, h.settings)
    await vi.advanceTimersByTimeAsync(0)
    h.mirror.applySingleCapUpdate(7, 'battery', { ...NATIVE, level: 41 })
    h.mirror.scheduleRuntimeStateDiskWrite(7, h.settings, 'battery')
    await flushDebounce()
    expect(writes).toHaveBeenCalledTimes(1)

    gate.resolve()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveBeenCalledTimes(2)
    const last = h.writes.at(-1)?.blob ?? {}
    expect(last.battery).toEqual({ ...NATIVE, level: 41 })
    expect(ownedOnRow(last)).toHaveProperty('battery')
  })
})
