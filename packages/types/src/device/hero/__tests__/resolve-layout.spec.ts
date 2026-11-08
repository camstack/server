import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { HERO_LAYOUT_BY_TYPE, HERO_LAYOUT_DEFAULT, resolveHeroLayout } from '../hero-layout.js'
import { HERO_ROW_IDS } from '../hero-model.js'

describe('fixed hero layouts', () => {
  it('declares a layout for every DeviceType, at runtime', () => {
    for (const type of Object.values(DeviceType)) {
      expect(HERO_LAYOUT_BY_TYPE[type], `layout for ${type}`).toBeDefined()
    }
  })

  it('names only known rows, each at most once', () => {
    for (const layout of Object.values(HERO_LAYOUT_BY_TYPE)) {
      expect(new Set(layout.rows).size).toBe(layout.rows.length)
      for (const row of layout.rows) expect(HERO_ROW_IDS).toContain(row)
    }
  })

  it('cannot hide the own power or the power supply: they are not rows', () => {
    for (const id of HERO_ROW_IDS) {
      expect(id).not.toMatch(/power-supply|own-power|^power$/)
    }
  })

  it('resolves by type, with the default for a type it does not know', () => {
    expect(resolveHeroLayout(DeviceType.Heater).rows[0]).toBe('run-for')
    expect(resolveHeroLayout(DeviceType.MediaPlayer).rows).toEqual([
      'now-playing',
      'playback',
      'volume',
      'source',
    ])
    expect(resolveHeroLayout('future-type')).toBe(HERO_LAYOUT_DEFAULT)
  })
})
