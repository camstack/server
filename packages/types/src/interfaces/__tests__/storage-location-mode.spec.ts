/**
 * The four-state storage-location model (D385) — the policy table, state by
 * state, and the legacy fold.
 *
 * The table is the contract every consumer and the admin UI were given
 * verbatim. It is asserted here exhaustively rather than by example: a fifth
 * state added without an answer for all three questions fails this file.
 */
import { describe, expect, it } from 'vitest'
import type { StorageLocationMode } from '../storage-location-mode.js'
import {
  evictionPolicyForMode,
  evictionPolicyOfLocation,
  legacyModeOf,
  mayReadLocation,
  mayWriteToLocation,
  modeMayRead,
  modeMayWrite,
  resolveLocationMode,
  STORAGE_LOCATION_MODES,
  StorageLocationModeSchema,
  strippedOfLegacyReadOnly,
  withLocationMode,
} from '../storage-location-mode.js'

const config = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  basePath: '/mnt/x',
  ...extra,
})

describe('the policy table', () => {
  const expected: ReadonlyArray<{
    readonly mode: StorageLocationMode
    readonly write: boolean
    readonly read: boolean
    readonly eviction: 'normal' | 'never' | 'drain'
  }> = [
    { mode: 'active', write: true, read: true, eviction: 'normal' },
    { mode: 'readonly', write: false, read: true, eviction: 'never' },
    { mode: 'drain', write: false, read: true, eviction: 'drain' },
    { mode: 'disabled', write: false, read: false, eviction: 'never' },
  ]

  it('covers every declared mode exactly once', () => {
    expect(expected.map((e) => e.mode).toSorted()).toEqual([...STORAGE_LOCATION_MODES].toSorted())
  })

  for (const row of expected) {
    it(`${row.mode}: write=${String(row.write)} read=${String(row.read)} eviction=${row.eviction}`, () => {
      expect(modeMayWrite(row.mode)).toBe(row.write)
      expect(modeMayRead(row.mode)).toBe(row.read)
      expect(evictionPolicyForMode(row.mode)).toBe(row.eviction)
    })
  }

  it('the schema admits exactly those four', () => {
    for (const mode of STORAGE_LOCATION_MODES) {
      expect(StorageLocationModeSchema.parse(mode)).toBe(mode)
    }
    expect(StorageLocationModeSchema.safeParse('frozen').success).toBe(false)
  })

  it('only `active` is a write target, and only `disabled` is unreadable', () => {
    const writable = STORAGE_LOCATION_MODES.filter(modeMayWrite)
    const unreadable = STORAGE_LOCATION_MODES.filter((m) => !modeMayRead(m))
    expect(writable).toEqual(['active'])
    expect(unreadable).toEqual(['disabled'])
  })

  it('a mode that cannot be read can never be written either', () => {
    for (const mode of STORAGE_LOCATION_MODES) {
      if (!modeMayRead(mode)) expect(modeMayWrite(mode)).toBe(false)
    }
  })
})

describe('resolveLocationMode — the legacy fold', () => {
  it('a stamped mode wins over anything legacy', () => {
    expect(
      resolveLocationMode({ mode: 'drain', enabled: false, config: config({ readOnly: true }) }),
    ).toBe('drain')
  })

  it('config.readOnly === true folds to readonly', () => {
    expect(resolveLocationMode({ config: config({ readOnly: true }) })).toBe('readonly')
  })

  it('enabled === false folds to readonly — the conservative direction', () => {
    // A state change must never START deleting footage on its own. `disabled`
    // would take the location out of READS as well, and `drain` would begin
    // erasing it; neither is what the old flag meant.
    expect(resolveLocationMode({ enabled: false, config: config() })).toBe('readonly')
  })

  it('everything else is active — including a flagless legacy row', () => {
    expect(resolveLocationMode({ config: config() })).toBe('active')
    expect(resolveLocationMode({ enabled: true, config: config() })).toBe('active')
    expect(resolveLocationMode({ config: config({ readOnly: false }) })).toBe('active')
  })

  it('a non-boolean readOnly is not a state — it reads as active', () => {
    expect(resolveLocationMode({ config: config({ readOnly: 'yes' }) })).toBe('active')
    expect(resolveLocationMode({ config: config({ readOnly: 1 }) })).toBe('active')
  })

  it('NO legacy combination can ever fold to `drain` or `disabled`', () => {
    // The fold is exhaustive over every combination of the two retired flags,
    // and every one of them lands on `readonly` or `active`. This is the
    // property, not an example: `config.readOnly → drain` was independently
    // guessed while this was being built, and it would have started DELETING
    // footage on locations an operator had frozen — the exact opposite of what
    // the flag meant. `disabled` would have hidden that footage from reads.
    const enabledValues: ReadonlyArray<boolean | undefined> = [true, false, undefined]
    const readOnlyValues: ReadonlyArray<unknown> = [true, false, undefined, 'true', 1, null]
    for (const enabled of enabledValues) {
      for (const readOnly of readOnlyValues) {
        const row = {
          ...(enabled !== undefined ? { enabled } : {}),
          config: config(readOnly === undefined ? {} : { readOnly }),
        }
        const mode = resolveLocationMode(row)
        expect(['active', 'readonly']).toContain(mode)
      }
    }
  })

  it('legacyModeOf says whether a row needed the fold at all', () => {
    expect(legacyModeOf({ config: config() })).toBeNull()
    expect(legacyModeOf({ config: config({ readOnly: true }) })).toBe('readonly')
    expect(legacyModeOf({ enabled: false, config: config() })).toBe('readonly')
    expect(legacyModeOf({ mode: 'active', enabled: false, config: config() })).toBeNull()
  })
})

describe('the legacy key is DELETED, not left to disagree', () => {
  it('strips readOnly and leaves the rest of config alone', () => {
    const before = config({ readOnly: true, minFreePercent: 12 })
    const after = strippedOfLegacyReadOnly(before)
    expect(after).toEqual({ basePath: '/mnt/x', minFreePercent: 12 })
    // Immutability: the input is untouched.
    expect(before['readOnly']).toBe(true)
  })

  it('returns the SAME object when there was nothing to strip', () => {
    const before = config()
    expect(strippedOfLegacyReadOnly(before)).toBe(before)
  })
})

describe('withLocationMode — enabled can never disagree with mode', () => {
  const base = {
    id: 'recordings:default',
    type: 'recordings',
    displayName: 'Recordings',
    providerId: 'filesystem',
    config: config({ readOnly: true }),
    isSystem: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }

  for (const mode of STORAGE_LOCATION_MODES) {
    it(`${mode} derives enabled = ${String(mode === 'active')}`, () => {
      const next = withLocationMode(base, mode)
      expect(next.mode).toBe(mode)
      expect(next.enabled).toBe(mode === 'active')
      expect(resolveLocationMode(next)).toBe(mode)
    })
  }

  it('drops the legacy readOnly key so the two authorities cannot disagree', () => {
    expect(withLocationMode(base, 'active').config['readOnly']).toBeUndefined()
  })
})

describe('the row-level questions', () => {
  it('read a disabled location: refused; a drained one: still readable', () => {
    expect(mayReadLocation({ mode: 'disabled', config: config() })).toBe(false)
    expect(mayReadLocation({ mode: 'drain', config: config() })).toBe(true)
    expect(mayWriteToLocation({ mode: 'drain', config: config() })).toBe(false)
    expect(mayWriteToLocation({ mode: 'active', config: config() })).toBe(true)
  })

  it('a legacy readOnly row is excluded from eviction; a legacy disabled one too', () => {
    expect(evictionPolicyOfLocation({ config: config({ readOnly: true }) })).toBe('never')
    expect(evictionPolicyOfLocation({ enabled: false, config: config() })).toBe('never')
    expect(evictionPolicyOfLocation({ config: config() })).toBe('normal')
  })
})
