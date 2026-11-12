// -environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_CARD_CSS } from '../card-css'
import {
  AMBIENT_LAYERS,
  AmbientFx,
  ambientLayers,
  ambientPace,
  speedBand,
  type AmbientActivity,
  type ClimateAmbientActivity,
} from '../illustrations/AmbientFx'
import { CLIMATE_ROLES, type ClimateRole } from '../illustrations/ClimateRoleGlyph'

afterEach(cleanup)

const ACTIVITIES: readonly ClimateAmbientActivity[] = [
  'off',
  'unknown',
  'idle',
  'heat',
  'cool',
  'window',
]

/** The scene each role draws, per activity: the approved Clima page. */
const EXPECTED: Readonly<Record<ClimateRole, Readonly<Record<ClimateAmbientActivity, string>>>> = {
  ac: {
    off: '',
    unknown: '',
    idle: 'breathe air',
    heat: 'wash-down air',
    cool: 'wash-down air',
    window: 'draft',
  },
  thermostat: {
    off: '',
    unknown: '',
    idle: 'breathe',
    heat: 'wash-up particles-rise',
    cool: 'wash-down particles-fall',
    window: 'draft',
  },
  floor: {
    off: '',
    unknown: '',
    idle: 'breathe serpentine',
    heat: 'wash-up serpentine wisps-floor',
    cool: 'wash-down serpentine',
    window: 'draft',
  },
  radiator: {
    off: '',
    unknown: '',
    idle: 'breathe radiator',
    heat: 'wash-up radiator wisps-unit',
    cool: 'wash-down particles-fall',
    window: 'draft',
  },
  heater: {
    off: '',
    unknown: '',
    idle: 'breathe heater',
    heat: 'wash-up heater wisps-unit',
    cool: 'wash-down particles-fall',
    window: 'draft',
  },
  hpcircuit: {
    off: '',
    unknown: '',
    idle: 'breathe pipe',
    heat: 'wash-up pipe',
    cool: 'wash-down pipe',
    window: 'draft',
  },
}

describe('ambient layer — one stack per (role, activity)', () => {
  for (const role of CLIMATE_ROLES) {
    for (const activity of ACTIVITIES) {
      it(`${role} · ${activity}`, () => {
        const expected = EXPECTED[role][activity]
        expect(ambientLayers(role, activity).join(' ')).toBe(expected)
        const { container } = render(<AmbientFx role={role} activity={activity} swing={false} />)
        const root = container.querySelector('[data-fx]')
        if (expected === '') {
          expect(root).toBeNull()
          return
        }
        expect(root?.getAttribute('data-fx')).toBe(expected)
        const drawn = Array.from(container.querySelectorAll('[data-fx-layer]')).map((el) =>
          el.getAttribute('data-fx-layer'),
        )
        expect(drawn.join(' ')).toBe(expected)
        for (const el of container.querySelectorAll('[data-fx-layer]')) {
          expect(el.childElementCount, 'a layer draws something').toBeGreaterThan(0)
        }
      })
    }
  }

  it('a running fan blows a breeze at its speed; a still fan draws nothing', () => {
    expect(ambientLayers('fan', 'run')).toEqual(['breeze'])
    expect(ambientLayers('fan', 'off')).toEqual([])
    const { container } = render(<AmbientFx role="fan" activity="run" swing={false} speed={90} />)
    const root = container.querySelector('[data-fx]')
    expect(root?.getAttribute('data-speed')).toBe('5')
    expect(root?.className).toContain('text-info')
    expect(container.querySelectorAll('.dc-fx-breeze i')).toHaveLength(4)
    expect([0, 10, 30, 50, 70, 100].map(speedBand)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('a heating switch-heater glows low from the floor, with wisps over the unit', () => {
    expect(ambientLayers('switch-heater', 'heat')).toEqual(['glow-low', 'wisps-unit'])
    expect(ambientLayers('switch-heater', 'off')).toEqual([])
    const { container } = render(<AmbientFx role="switch-heater" activity="heat" swing={false} />)
    expect(container.querySelector('.dc-fx-wash[data-low]')).not.toBeNull()
    expect(container.querySelectorAll('.dc-fx-wisps[data-at="unit"] i')).toHaveLength(3)
  })

  it('every live role has a background, and heat never looks like cool', () => {
    for (const role of CLIMATE_ROLES) {
      expect(ambientLayers(role, 'heat').length, role).toBeGreaterThan(1)
      expect(ambientLayers(role, 'cool').length, role).toBeGreaterThan(1)
      expect(ambientLayers(role, 'idle')[0], role).toBe('breathe')
    }
    expect(ambientLayers('thermostat', 'heat')).not.toEqual(ambientLayers('thermostat', 'cool'))
  })

  it('takes its colour from the activity, through a theme token', () => {
    const tone = (activity: AmbientActivity): string => {
      const { container } = render(
        <AmbientFx role="thermostat" activity={activity} swing={false} />,
      )
      const cls = container.querySelector('[data-fx]')?.className ?? ''
      cleanup()
      return cls
    }
    expect(tone('heat')).toContain('text-primary')
    expect(tone('cool')).toContain('text-info')
    expect(tone('window')).toContain('text-info')
    expect(tone('idle')).toContain('text-foreground-muted')
  })

  it('sways the air stream only when swing is on, and slows down in standby', () => {
    const air = (swing: boolean, activity: AmbientActivity): Element | null =>
      render(<AmbientFx role="ac" activity={activity} swing={swing} />).container.querySelector(
        '.dc-fx-air',
      )
    expect(air(true, 'cool')?.getAttribute('data-sway')).toBe('true')
    expect(air(false, 'cool')?.getAttribute('data-sway')).toBe('false')
    expect(ambientPace('idle')).toBe('slow')
    expect(ambientPace('window')).toBe('live')
    expect(ambientPace('heat')).toBe('live')
  })

  it('has a style rule for every layer and stops under reduced motion', () => {
    const hooks: Readonly<Record<(typeof AMBIENT_LAYERS)[number], string>> = {
      'wash-up': '.dc-fx-wash[data-from="bottom"]',
      'wash-down': '.dc-fx-wash[data-from="top"]',
      breathe: '.dc-fx-breathe{',
      'particles-rise': '.dc-fx-p[data-dir="rise"]',
      'particles-fall': '.dc-fx-p i{',
      air: '.dc-fx-air{',
      serpentine: '.dc-fx-serp{',
      'wisps-floor': '.dc-fx-wisps[data-at="floor"]',
      'wisps-unit': '.dc-fx-wisps[data-at="unit"]',
      radiator: '.dc-fx-unit{',
      heater: '.dc-fx-coil{',
      pipe: '.dc-fx-pipe{',
      draft: '.dc-fx-draft i{',
      'glow-low': '.dc-fx-wash[data-low]{height:30%}',
      breeze: '.dc-fx-breeze i{',
    }
    for (const layer of AMBIENT_LAYERS) expect(DEVICE_CARD_CSS, layer).toContain(hooks[layer])
    expect(DEVICE_CARD_CSS).toContain(
      '@media (prefers-reduced-motion:reduce){.dc-fx *,.dc-fx{animation:none!important}',
    )
    expect(DEVICE_CARD_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })
})
