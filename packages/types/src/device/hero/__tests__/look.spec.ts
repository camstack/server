import { describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '../../device-type.js'
import { ICON_KEYS } from '../../icon-catalog.generated.js'
import {
  allHeroLooks,
  HERO_LOOK_BY_ROLE,
  HERO_LOOK_BY_TYPE,
  HERO_LOOK_DEFAULT,
  resolveHeroLook,
} from '../hero-look.js'
import { HERO_ANIMATIONS, HERO_BACKGROUNDS, HERO_STATES, HERO_TONES } from '../hero-state.js'

describe('hero look exhaustiveness', () => {
  it('declares a look for every DeviceType, at runtime', () => {
    for (const type of Object.values(DeviceType)) {
      expect(HERO_LOOK_BY_TYPE[type], `look for type ${type}`).toBeDefined()
    }
  })

  it('declares an entry for every DeviceRole, at runtime', () => {
    for (const role of Object.values(DeviceRole)) {
      expect(HERO_LOOK_BY_ROLE[role], `entry for role ${role}`).toBeDefined()
    }
  })

  it('every look declares every state with a real icon, tone, background and animation', () => {
    const icons = new Set<string>(ICON_KEYS)
    for (const look of allHeroLooks()) {
      expect(Object.keys(look).sort()).toEqual([...HERO_STATES].sort())
      for (const state of HERO_STATES) {
        const l = look[state]
        expect(icons.has(l.icon), `icon ${l.icon}`).toBe(true)
        expect(HERO_TONES).toContain(l.tone)
        expect(HERO_BACKGROUNDS).toContain(l.background)
        expect(HERO_ANIMATIONS).toContain(l.animation)
      }
    }
  })
})

describe('resolveHeroLook', () => {
  it('a heater heats while on and is still when off', () => {
    const on = resolveHeroLook(null, DeviceType.Heater, 'on')
    const off = resolveHeroLook(null, DeviceType.Heater, 'off')
    expect(on).toMatchObject({ icon: 'flame', background: 'heat-rise', animation: 'rise' })
    expect(off).toMatchObject({ background: 'plain', animation: 'none' })
  })

  it('a washer tumbles only while running', () => {
    expect(resolveHeroLook(null, DeviceType.Washer, 'running').animation).toBe('tumble')
    expect(resolveHeroLook(null, DeviceType.Washer, 'on').animation).toBe('none')
  })

  it('a media player equalizes while running', () => {
    expect(resolveHeroLook(null, DeviceType.MediaPlayer, 'running').animation).toBe('equalizer')
  })

  it('unknown has its own look, never the off look', () => {
    const unknown = resolveHeroLook(null, DeviceType.Heater, 'unknown')
    expect(unknown).not.toEqual(resolveHeroLook(null, DeviceType.Heater, 'off'))
  })

  it('a role refines the type: a leak sensor reads as water, a plain sensor does not', () => {
    expect(resolveHeroLook(DeviceRole.LeakSensor, DeviceType.Sensor, 'on').icon).toBe('droplets')
    expect(resolveHeroLook(DeviceRole.TemperatureSensor, DeviceType.Sensor, 'on')).toEqual(
      HERO_LOOK_BY_TYPE[DeviceType.Sensor].on,
    )
  })

  it('a type this build does not know, and a role it does not know, fall back to the default', () => {
    expect(resolveHeroLook('not-a-role', 'future-type', 'off')).toEqual(HERO_LOOK_DEFAULT.off)
  })
})
