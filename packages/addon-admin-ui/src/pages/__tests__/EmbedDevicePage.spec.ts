import { describe, expect, it } from 'vitest'
import { parseEmbedDeviceId, parseEmbedLocale, parseEmbedTheme } from '../EmbedDevicePage'

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
