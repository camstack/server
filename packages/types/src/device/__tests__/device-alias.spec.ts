import { describe, expect, it } from 'vitest'
import {
  DEVICE_ALIAS_MAX_LENGTH,
  checkDeviceAlias,
  generateDeviceAlias,
  slugifyDeviceAlias,
} from '../device-alias.js'

describe('slugifyDeviceAlias', () => {
  it('lowercases, strips accents and joins words with underscores', () => {
    expect(slugifyDeviceAlias('Stufa Veranda')).toBe('stufa_veranda')
    expect(slugifyDeviceAlias('Cucina – Perché?')).toBe('cucina_perche')
    expect(slugifyDeviceAlias('  --Hello__World-- ')).toBe('hello_world')
  })

  it('never answers an empty or digit-leading identifier', () => {
    expect(slugifyDeviceAlias('???')).toBe('device')
    expect(slugifyDeviceAlias('3D printer')).toBe('device_3d_printer')
  })

  it('is bounded', () => {
    expect(slugifyDeviceAlias('a'.repeat(300)).length).toBeLessThanOrEqual(DEVICE_ALIAS_MAX_LENGTH)
  })
})

describe('generateDeviceAlias', () => {
  it('dedupes with _2, _3 against the taken set', () => {
    const taken = new Set(['stufa', 'stufa_2'])
    expect(generateDeviceAlias('Stufa', (a) => taken.has(a))).toBe('stufa_3')
  })

  it('does not hand out a template keyword', () => {
    expect(generateDeviceAlias('Range', () => false)).toBe('range_2')
    expect(generateDeviceAlias('loop', () => false)).toBe('loop_2')
  })
})

describe('checkDeviceAlias', () => {
  const none = (): boolean => false
  it('accepts an entity_id style name', () => {
    expect(checkDeviceAlias('stufa_veranda', none)).toEqual({ ok: true, alias: 'stufa_veranda' })
  })
  it('refuses by typed reason', () => {
    expect(checkDeviceAlias('', none)).toEqual({ ok: false, reason: 'empty' })
    expect(checkDeviceAlias('Stufa', none)).toEqual({ ok: false, reason: 'grammar' })
    expect(checkDeviceAlias('1stufa', none)).toEqual({ ok: false, reason: 'grammar' })
    expect(checkDeviceAlias('a'.repeat(DEVICE_ALIAS_MAX_LENGTH + 1), none)).toEqual({
      ok: false,
      reason: 'too-long',
    })
    expect(checkDeviceAlias('true', none)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkDeviceAlias('stufa', (a) => a === 'stufa')).toEqual({ ok: false, reason: 'taken' })
  })
})
