import { describe, expect, it } from 'vitest'
import { migrateRetiredPreRollOverride } from '../prebuffer-migration.js'
import { PREBUFFER_MAX_SEC } from '../prebuffer.js'

/**
 * D381 retires `DeviceOverride.preRollMs`. These tests exist because the
 * alternative to migrating it is a SILENT strip — `DeviceOverrideSchema` is a
 * plain `z.object`, so a key merely deleted from the shape survives one parse
 * and vanishes on the next save, taking an operator's configured history with
 * it and printing nothing. That is the failure D380 came one commit from
 * shipping, and it is why the retired key is still declared.
 */
describe('migrateRetiredPreRollOverride', () => {
  it('leaves an override that never had the retired key untouched, by reference', () => {
    const input = { preBuffer: { 'native:main': { enabled: true, seconds: 5 } } }
    const result = migrateRetiredPreRollOverride(input)
    expect(result.override).toBe(input)
    expect(result.migrated).toEqual([])
  })

  it('turns a configured pre-roll into a prebuffer of the same seconds', () => {
    const result = migrateRetiredPreRollOverride({ preRollMs: { 'native:sub': 3000 } })
    expect(result.override.preBuffer).toEqual({ 'native:sub': { enabled: true, seconds: 3 } })
    expect(result.migrated).toEqual(['native:sub'])
  })

  /** Rounding DOWN would hand back a narrower window than the one running. */
  it('rounds partial seconds UP — the direction that cannot lose media', () => {
    const result = migrateRetiredPreRollOverride({ preRollMs: { 'native:sub': 2500 } })
    expect(result.override.preBuffer?.['native:sub']?.seconds).toBe(3)
  })

  it('clamps a retired value above the prebuffer ceiling', () => {
    const result = migrateRetiredPreRollOverride({ preRollMs: { s: 999_000 } })
    expect(result.override.preBuffer?.s?.seconds).toBe(PREBUFFER_MAX_SEC)
  })

  /**
   * The operator answered the same question later and more directly. A
   * migration that overwrote it would be this subsystem's original sin once
   * more — two writers for one number.
   */
  it('never overwrites an explicit prebuffer override; it reports the conflict', () => {
    const result = migrateRetiredPreRollOverride({
      preBuffer: { 'native:main': { enabled: false, seconds: 0 } },
      preRollMs: { 'native:main': 4000 },
    })
    expect(result.override.preBuffer).toEqual({ 'native:main': { enabled: false, seconds: 0 } })
    expect(result.superseded).toEqual(['native:main'])
    expect(result.migrated).toEqual([])
  })

  it('always clears the retired key, so it cannot be read a second time', () => {
    const result = migrateRetiredPreRollOverride({ preRollMs: { s: 1000 } })
    expect('preRollMs' in result.override).toBe(false)
  })

  it('is idempotent — migrating twice changes nothing', () => {
    const once = migrateRetiredPreRollOverride({ preRollMs: { s: 3000 } })
    const twice = migrateRetiredPreRollOverride(once.override)
    expect(twice.override).toEqual(once.override)
    expect(twice.migrated).toEqual([])
  })

  it('drops a zero or nonsense retired value rather than enabling a 1 s prebuffer', () => {
    const result = migrateRetiredPreRollOverride({
      preRollMs: { a: 0, b: Number.NaN, c: -5 },
    })
    expect(result.override.preBuffer).toBeUndefined()
    expect(result.migrated).toEqual([])
  })
})
