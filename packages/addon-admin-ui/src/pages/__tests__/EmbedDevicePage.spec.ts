import { describe, expect, it } from 'vitest'
import {
  embedCanActuate,
  embedMainClass,
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

  it("follows the hub's answer for THIS device, not the admin flag", () => {
    expect(embedCanActuate({ view: true, command: true }, false)).toBe(true)
    expect(embedCanActuate({ view: true, command: false }, false)).toBe(false)
    // The hub's per-device answer wins over the admin flag in both directions.
    expect(embedCanActuate({ view: true, command: false }, true)).toBe(false)
  })

  it('without an answer only an admin may act', () => {
    expect(embedCanActuate(null, true)).toBe(true)
    expect(embedCanActuate(null, false)).toBe(false)
  })
})

describe('EmbedDevicePage page frame', () => {
  it('paints its own canvas for a browser, none for the viewer sheet', () => {
    expect(embedMainClass('dark', false)).toContain('bg-background')
    const viewer = embedMainClass('dark', true)
    expect(viewer).toContain('bg-transparent')
    expect(viewer).not.toContain('bg-background')
    expect(viewer.startsWith('dark ')).toBe(true)
  })
})
