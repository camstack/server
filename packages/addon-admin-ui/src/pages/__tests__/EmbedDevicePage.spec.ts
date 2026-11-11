import { describe, expect, it } from 'vitest'
import {
  embedCanActuate,
  parseEmbedDeviceId,
  parseEmbedHost,
  parseEmbedLocale,
  parseEmbedTheme,
} from '../EmbedDevicePage'

describe('EmbedDevicePage query parsing', () => {
  it('reads a positive integer device id and refuses anything else', () => {
    expect(parseEmbedDeviceId('1207')).toBe(1207)
    for (const bad of [undefined, '', '0', '-3', '1.5', '12ab', '9'.repeat(30)]) {
      expect(parseEmbedDeviceId(bad)).toBeNull()
    }
  })

  it('accepts only the known themes and locales', () => {
    expect(parseEmbedTheme('dark')).toBe('dark')
    expect(parseEmbedTheme('sepia')).toBeNull()
    expect(parseEmbedLocale('it')).toBe('it')
    expect(parseEmbedLocale('fr')).toBeNull()
    expect(parseEmbedLocale(null)).toBeNull()
  })
})

describe('EmbedDevicePage host and permission', () => {
  it('drops the name only for the viewer host it names', () => {
    expect(parseEmbedHost('viewer')).toBe('viewer')
    expect(parseEmbedHost('admin')).toBeNull()
    expect(parseEmbedHost(null)).toBeNull()
  })

  const scoped = (all: boolean, deviceCount: number) => ({
    isAdmin: false,
    scope: { isAdmin: false, device: { create: { all, deviceCount } } },
  })

  it('reads the user grant, not the admin flag: a non-admin allowed to command may act', () => {
    expect(embedCanActuate(scoped(false, 3))).toBe(true)
    expect(embedCanActuate(scoped(true, 0))).toBe(true)
    expect(embedCanActuate(scoped(false, 0))).toBe(false)
  })

  it('an admin may act; a session without a scope or without an answer may not', () => {
    expect(embedCanActuate({ isAdmin: true })).toBe(true)
    expect(embedCanActuate({ isAdmin: false })).toBe(false)
    expect(embedCanActuate(null)).toBe(false)
  })
})
