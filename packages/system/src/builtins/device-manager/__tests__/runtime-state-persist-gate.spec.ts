/**
 * The two gates that decide whether a runtime-state change costs a commit.
 *
 * Gate 1 — DURABILITY. A cap declaring `durability: 'session'` is mirrored in
 * RAM and never reaches disk. `audio-metrics` and `zone-analytics` alone are
 * ~90 % of the fleet's offered write rate (measured 2026-08-13: 3,897 of 5,765
 * sampled slice changes in 25 minutes) and a restored dB reading is a lie the
 * UI renders as current.
 *
 * Gate 2 — EFFECTIVE CHANGE. A blob that differs from the last PERSISTED one
 * only in fields the cap declared volatile is not written. Measured on the same
 * run: `battery` wrote 526 times while not one percentage moved; `privacy-mask`
 * 22 of 22; `humidity-sensor` 67 of 75; `numeric-sensor` 251 of 669. About half
 * of every non-hot runtime-state write on this installation is a device
 * recording that it re-read a value that had not changed.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeStatePolicy } from '@camstack/types'
import { OWNED_FIELDS_KEY } from '../field-ownership.js'
import {
  effectivelyEqual,
  persistableBlob,
  sliceEffectivelyEqual,
} from '../runtime-state-persist-gate.js'

const POLICY: Record<string, RuntimeStatePolicy> = {
  battery: { durability: 'restored', volatileFields: ['lastUpdated'] },
  'device-status': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  zones: { durability: 'restored', volatileFields: [] },
  doorbell: { durability: 'restored', volatileFields: [] },
  'audio-metrics': { durability: 'session', volatileFields: [] },
  motion: { durability: 'session', volatileFields: [] },
}
const policyFor = (cap: string): RuntimeStatePolicy =>
  POLICY[cap] ?? { durability: 'session', volatileFields: [] }

describe('persistableBlob — the durability gate', () => {
  it('keeps only the restored slices', () => {
    const blob = persistableBlob(
      {
        battery: { percentage: 80, lastUpdated: 1 },
        'audio-metrics': { avgDbfs: -39.4, ts: 2 },
        zones: { zones: [{ id: 'a' }] },
        motion: { detected: true },
      },
      policyFor,
    )
    expect(Object.keys(blob).sort()).toEqual(['battery', 'zones'])
  })

  it('a cap the policy has never heard of is session-only', () => {
    // An addon-private slice must not start persisting because nobody said no.
    expect(persistableBlob({ 'some-private-cap': { x: 1 } }, policyFor)).toEqual({})
  })

  it('is empty, not undefined, when the device carries only session slices', () => {
    expect(persistableBlob({ 'audio-metrics': { ts: 1 } }, policyFor)).toEqual({})
  })

  it('$owned is always persistable — it is a claims record, not a cap (D663)', () => {
    // The lookup knows no cap named `$owned`, so it would answer session-only;
    // the claims must reach disk regardless, or a restart forgets who owns what.
    const owned = {
      'audio-metrics': { owner: 'blk-1', mode: 'add', fields: ['avgDbfs'], values: {} },
    }
    expect(
      persistableBlob({ 'audio-metrics': { avgDbfs: -39 }, [OWNED_FIELDS_KEY]: owned }, policyFor),
    ).toEqual({ [OWNED_FIELDS_KEY]: owned })
  })
})

describe('sliceEffectivelyEqual — the clock exclusion', () => {
  it('a moved clock with an unmoved value is NOT a change', () => {
    expect(
      sliceEffectivelyEqual(
        { percentage: 80, charging: false, lastUpdated: 1_000 },
        { percentage: 80, charging: false, lastUpdated: 9_999 },
        ['lastUpdated'],
      ),
    ).toBe(true)
  })

  it('a moved value IS a change even when the clock stands still', () => {
    expect(
      sliceEffectivelyEqual(
        { percentage: 80, lastUpdated: 1_000 },
        { percentage: 79, lastUpdated: 1_000 },
        ['lastUpdated'],
      ),
    ).toBe(false)
  })

  it('an undeclared clock field is content — a cap must ask', () => {
    expect(
      sliceEffectivelyEqual(
        { percentage: 80, lastUpdated: 1 },
        { percentage: 80, lastUpdated: 2 },
        [],
      ),
    ).toBe(false)
  })

  it('compares nested objects and arrays BY VALUE, not by reference', () => {
    // `shallowEqual` (reference equality) is what made every slice with an
    // object or array field — 25+ of the 62 caps — dedupe never.
    expect(
      sliceEffectivelyEqual(
        { zones: [{ id: 'a', polygon: [{ x: 0.1, y: 0.2 }] }] },
        { zones: [{ id: 'a', polygon: [{ x: 0.1, y: 0.2 }] }] },
        [],
      ),
    ).toBe(true)
    expect(
      sliceEffectivelyEqual(
        { zones: [{ id: 'a', polygon: [{ x: 0.1, y: 0.2 }] }] },
        { zones: [{ id: 'a', polygon: [{ x: 0.1, y: 0.3 }] }] },
        [],
      ),
    ).toBe(false)
  })

  it('a field appearing or disappearing is a change', () => {
    expect(sliceEffectivelyEqual({ a: 1 }, { a: 1, b: 2 }, [])).toBe(false)
    expect(sliceEffectivelyEqual({ a: 1, b: undefined }, { a: 1 }, [])).toBe(false)
  })

  it('a volatile field appearing or disappearing is still not a change', () => {
    expect(sliceEffectivelyEqual({ a: 1 }, { a: 1, lastUpdated: 5 }, ['lastUpdated'])).toBe(true)
  })

  it('distinguishes null from a missing key', () => {
    expect(sliceEffectivelyEqual({ a: null }, { a: undefined }, [])).toBe(false)
  })
})

describe('effectivelyEqual — whole-blob', () => {
  it('the battery case: 526 writes, zero real changes, one commit', () => {
    const before = { battery: { percentage: 47, charging: false, lastUpdated: 1_000 } }
    const after = { battery: { percentage: 47, charging: false, lastUpdated: 1_060_000 } }
    expect(effectivelyEqual(before, after, policyFor)).toBe(true)
  })

  it('one real change anywhere in the blob wins', () => {
    const before = {
      battery: { percentage: 47, lastUpdated: 1_000 },
      'device-status': { online: true, lastChangedAt: 1 },
    }
    const after = {
      battery: { percentage: 47, lastUpdated: 9_000 },
      'device-status': { online: false, lastChangedAt: 2 },
    }
    expect(effectivelyEqual(before, after, policyFor)).toBe(false)
  })

  it('a cap slice appearing for the first time is a change', () => {
    expect(effectivelyEqual({}, { zones: { zones: [] } }, policyFor)).toBe(false)
  })

  it('a cap slice disappearing is a change — a dropped slice must reach disk', () => {
    expect(effectivelyEqual({ zones: { zones: [] } }, {}, policyFor)).toBe(false)
  })

  it('doorbell timestamps are content: the slice IS the record', () => {
    // `lastPressedAt` is deliberately NOT in doorbell's volatileStateFields.
    expect(
      effectivelyEqual(
        { doorbell: { pressCountSinceStart: 3, lastPressedAt: 100 } },
        { doorbell: { pressCountSinceStart: 3, lastPressedAt: 200 } },
        policyFor,
      ),
    ).toBe(false)
  })
})
