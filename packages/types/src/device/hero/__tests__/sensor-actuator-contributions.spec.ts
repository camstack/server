import { describe, expect, it } from 'vitest'
import { DeviceFeature, DeviceRole, DeviceType } from '../../device-type.js'
import { resolveHeroLook } from '../hero-look.js'
import { actionsOf, build, NOW, primaryOf, rowOf } from './hero-test-kit.js'

const POWER_WORDS = ['On', 'Off', 'Acceso', 'Spento']

describe('alarm sensors read Clear vs alert, never a power word', () => {
  const cases = [
    [
      'smoke',
      { detected: true, lastChangedAt: NOW - 120_000 },
      { detected: false, lastChangedAt: 0 },
      'Smoke detected',
      'Clear',
    ],
    [
      'flood',
      { flooded: true, lastChangedAt: 0 },
      { flooded: false, lastChangedAt: 0 },
      'Leak detected',
      'Dry',
    ],
    [
      'gas',
      { detected: true, lastChangedAt: 0 },
      { detected: false, lastChangedAt: 0 },
      'Gas detected',
      'Clear',
    ],
    [
      'tamper',
      { tampered: true, lastChangedAt: 0 },
      { tampered: false, lastChangedAt: 0 },
      'Tampered',
      'Secure',
    ],
  ] as const
  for (const [cap, tripped, calm, yes, no] of cases) {
    it(cap, () => {
      const a = build(DeviceType.Sensor, [cap], { [cap]: tripped })
      expect(a.state).toBe('alert')
      expect(a.title.en).toBe(yes)
      expect(a.look.tone).toBe('danger')
      expect(a.look.icon).not.toBe('power')
      const c = build(DeviceType.Sensor, [cap], { [cap]: calm })
      expect(c.state).toBe('idle')
      expect(c.title.en).toBe(no)
      expect(POWER_WORDS).not.toContain(c.title.en)
      expect(c.look.icon).not.toBe('power')
      const u = build(DeviceType.Sensor, [cap], {})
      expect(u.state).toBe('unknown')
      expect(u.title.en).toBe('—')
    })
  }
  it('a tripped alarm wins over a calmer reading of the same device', () => {
    const m = build(DeviceType.Sensor, ['contact', 'tamper'], {
      contact: { entryOpen: false, lastChangedAt: 0 },
      tamper: { tampered: true, lastChangedAt: 0 },
    })
    expect(m.state).toBe('alert')
  })
  it('role looks give each alarm its own icon', () => {
    expect(resolveHeroLook(DeviceRole.SmokeSensor, DeviceType.Sensor, 'alert').icon).toBe('flame')
    expect(resolveHeroLook(DeviceRole.TamperSensor, DeviceType.Sensor, 'alert').icon).toBe(
      'shield-alert',
    )
  })
})

describe('motion, vibration, binary', () => {
  it('motion reads Detected / Clear / Unknown', () => {
    const on = build(DeviceType.Sensor, ['motion'], {
      motion: {
        detected: true,
        lastDetectedAt: NOW - 60_000,
        autoClearAfterMs: null,
      },
    })
    expect(on.state).toBe('on')
    expect(on.title.en).toBe('Detected')
    const off = build(DeviceType.Sensor, ['motion'], {
      motion: {
        detected: false,
        lastDetectedAt: NOW - 3_600_000,
        autoClearAfterMs: null,
      },
    })
    expect(off.title.en).toBe('Clear')
    expect(off.facts[0]?.text.en).toBe('Last motion 1 h ago')
    expect(build(DeviceType.Sensor, ['motion'], {}).state).toBe('unknown')
  })
  it('vibration and binary have their own words', () => {
    expect(
      build(DeviceType.Sensor, ['vibration'], {
        vibration: { detected: true, lastChangedAt: 0 },
      }).title.en,
    ).toBe('Vibration')
    expect(
      build(DeviceType.Sensor, ['binary'], {
        binary: { on: false, lastChangedAt: 0 },
      }).title.en,
    ).toBe('Inactive')
    expect(build(DeviceType.Sensor, ['binary'], {}).state).toBe('unknown')
  })
})

describe('presence', () => {
  const slice = (state: string) => ({
    presence: { state, location: null, gps: null, lastChangedAt: 0 },
  })
  it('home / away / a named zone; unread is unknown', () => {
    expect(build(DeviceType.Presence, ['presence'], slice('home')).title.en).toBe('Home')
    const away = build(DeviceType.Presence, ['presence'], slice('not_home'))
    expect(away.title.en).toBe('Away')
    expect(away.look.icon).toBe('map-pin')
    expect(build(DeviceType.Presence, ['presence'], slice('work')).title.en).toBe('work')
    expect(build(DeviceType.Presence, ['presence'], {}).state).toBe('unknown')
  })
})

describe('doorbell', () => {
  it('reads the last ring, ringing when fresh, and never unlocks', () => {
    const old = build(DeviceType.Button, ['doorbell'], {
      doorbell: { lastPressedAt: NOW - 5 * 60_000, pressCountSinceStart: 3 },
    })
    expect(old.title.en).toBe('Last ring 5 min ago')
    expect(old.rows).toEqual([])
    const fresh = build(DeviceType.Button, ['doorbell'], {
      doorbell: { lastPressedAt: NOW - 5_000, pressCountSinceStart: 1 },
    })
    expect(fresh.title.en).toBe('Ringing')
    expect(
      build(DeviceType.Button, ['doorbell'], {
        doorbell: { lastPressedAt: null, pressCountSinceStart: 0 },
      }).title.en,
    ).toBe('No ring yet')
    expect(build(DeviceType.Button, ['doorbell'], {}).state).toBe('unknown')
  })
  it('a camera that also reports motion keeps motion words', () => {
    const m = build(DeviceType.Camera, ['doorbell', 'motion'], {
      doorbell: { lastPressedAt: NOW - 600_000, pressCountSinceStart: 1 },
      motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
    })
    expect(m.title.en).toBe('Clear')
    expect(m.look.icon).toBe('video')
  })
})

describe('meter, weather, image, control', () => {
  it('a meter reads its value; a gap is unknown, never zero', () => {
    expect(
      build(DeviceType.Sensor, ['meter'], {
        meter: { value: 12.345, lastFetchedAt: 0 },
      }).title.en,
    ).toBe('12.35')
    expect(
      build(DeviceType.Sensor, ['meter'], {
        meter: { value: null, lastFetchedAt: 0 },
      }).state,
    ).toBe('unknown')
  })
  it('weather reads its condition and facts; a null measurement is absent', () => {
    const m = build(DeviceType.Weather, ['weather'], {
      weather: {
        condition: 'partlycloudy',
        temperature: 21.4,
        humidity: 60,
        pressure: null,
        windSpeed: null,
        windBearing: null,
        lastFetchedAt: 0,
      },
    })
    expect(m.title.en).toBe('Partly cloudy')
    expect(m.look.icon).toBe('cloud-sun')
    expect(m.facts.map((f) => f.text.en)).toEqual(['21.4°C', '60%'])
    expect(m.sideTiles.right).toEqual([])
    expect(
      build(DeviceType.Weather, ['weather'], {
        weather: {
          condition: null,
          temperature: 3,
          humidity: null,
          pressure: null,
          windSpeed: null,
          windBearing: null,
          lastFetchedAt: 0,
        },
      }).title.en,
    ).toBe('3°C')
  })
  it('an image is the artwork; no url is an answer, not unknown', () => {
    const m = build(DeviceType.Image, ['image'], {
      image: { url: 'https://x/y.png', lastUpdated: NOW - 120_000 },
    })
    expect(m.background.kind).toBe('artwork')
    expect(m.title.en).toBe('Updated 2 min ago')
    expect(
      build(DeviceType.Image, ['image'], {
        image: { url: null, lastUpdated: null },
      }).title.en,
    ).toBe('No image yet')
  })
  it('a control reads its value', () => {
    const m = build(DeviceType.Control, ['control'], {
      control: { kind: 'numeric', value: 5, options: [], lastChangedAt: 0 },
    })
    expect(m.title.en).toBe('5')
    expect(m.look.icon).toBe('sliders-horizontal')
    expect(build(DeviceType.Control, ['control'], {}).state).toBe('unknown')
  })
})

describe('update and button', () => {
  const upd = (extra: object) => ({
    update: {
      currentVersion: '1.0',
      availableVersion: '1.1',
      updatable: true,
      state: null,
      inProgress: false,
      ...extra,
    },
  })
  it('update reads the versions and offers no action: its install method addresses no device', () => {
    const m = build(DeviceType.Update, ['update'], upd({}))
    expect(m.state).toBe('standby')
    expect(m.title.en).toBe('Update available')
    expect(actionsOf(rowOf(m, 'update').controls)).toEqual([])
    expect(JSON.stringify(m)).not.toContain('installUpdate')
    const done = build(DeviceType.Update, ['update'], upd({ availableVersion: '1.0' }))
    expect(done.title.en).toBe('Up to date')
    expect(actionsOf(rowOf(done, 'update').controls)).toEqual([])
    expect(build(DeviceType.Update, ['update'], upd({ inProgress: true })).state).toBe('running')
    expect(build(DeviceType.Update, ['update'], {}).state).toBe('unknown')
  })
  it('a button is ready and offers a confirmed press', () => {
    const m = build(DeviceType.Button, ['button'])
    expect(m.title.en).toBe('Ready')
    expect(primaryOf(m, 'button')).toMatchObject({
      confirm: 'press',
      call: { method: 'press' },
    })
  })
})

describe('light', () => {
  it('a dimmer shows level and a slider; colour is shown as words', () => {
    const m = build(DeviceType.Light, ['switch', 'brightness', 'color'], {
      switch: { on: true, lastChangedAt: 0 },
      brightness: { level: 60, lastChangedAt: 0 },
      color: { mode: 'mired', colorTemperature: 370, lastChangedAt: 0 },
    })
    expect(m.state).toBe('on')
    expect(m.look.icon).toBe('lightbulb')
    expect(m.scene).toMatchObject({ id: 'light', level: 0.6 })
    expect(rowOf(m, 'brightness').controls[0]).toMatchObject({
      kind: 'slider',
      value: 60,
    })
    expect(rowOf(m, 'color').status?.en).toBe('2703 K')
  })
  it('brightness alone: level 0 is off, unread is unknown', () => {
    expect(
      build(DeviceType.Light, ['brightness'], {
        brightness: { level: 0, lastChangedAt: 0 },
      }).state,
    ).toBe('off')
    const u = build(DeviceType.Light, ['brightness'], {})
    expect(u.state).toBe('unknown')
    expect(rowOf(u, 'brightness').controls[0]).toMatchObject({ value: null })
  })
})

describe('cover and valve', () => {
  const cover = (state: string, position: number | null = null) => ({
    cover: { state, position, tiltPosition: null, lastChangedAt: 0 },
  })
  it('cover words, scene and controls; open/close are actions, the next move is primary', () => {
    const m = build(DeviceType.Cover, ['cover'], cover('open', 60), [
      DeviceFeature.CoverPositionable,
      DeviceFeature.CoverStoppable,
    ])
    expect(m.title.en).toBe('60% open')
    expect(m.scene).toMatchObject({ id: 'cover', mode: 'open', level: 0.6 })
    expect(m.look.icon).toBe('blinds')
    expect(actionsOf(rowOf(m, 'cover').controls).map((a) => a.call.method)).toEqual([
      'open',
      'stop',
      'close',
    ])
    expect(rowOf(m, 'cover').controls.some((c) => c.kind === 'slider')).toBe(true)
    expect(primaryOf(m, 'cover')?.call.method).toBe('close')
    const closed = build(DeviceType.Cover, ['cover'], cover('closed', 0))
    expect(closed.title.en).toBe('Closed')
    expect(closed.state).toBe('off')
    expect(primaryOf(closed, 'cover')?.call.method).toBe('open')
    expect(build(DeviceType.Cover, ['cover'], cover('closing')).state).toBe('running')
  })
  it('unread cover is unknown, not closed, and still offers open / close', () => {
    const m = build(DeviceType.Cover, ['cover'], {})
    expect(m.state).toBe('unknown')
    expect(actionsOf(rowOf(m, 'cover').controls).map((a) => a.call.method)).toEqual([
      'open',
      'close',
    ])
  })
  it('valve open / close are plain actions with no confirm', () => {
    const m = build(DeviceType.Valve, ['valve'], {
      valve: { state: 'closed', position: null, lastChangedAt: 0 },
    })
    expect(m.title.en).toBe('Closed')
    const acts = actionsOf(rowOf(m, 'valve').controls)
    expect(acts.map((a) => a.call.method)).toEqual(['open', 'close'])
    expect(acts.every((a) => a.confirm === null)).toBe(true)
  })
})

describe('humidifier', () => {
  const h = (extra: object) => ({
    humidifier: {
      on: true,
      currentHumidity: 45,
      targetHumidity: 55,
      mode: 'auto',
      availableModes: ['auto', 'baby'],
      action: 'humidifying',
      minHumidity: 30,
      maxHumidity: 80,
      lastChangedAt: 0,
      ...extra,
    },
  })
  it('humidifying, idle, off; power toggle, target slider and mode picker', () => {
    const m = build(DeviceType.Humidifier, ['humidifier'], h({}))
    expect(m.state).toBe('running')
    expect(m.title.en).toBe('Humidifying')
    expect(rowOf(m, 'humidifier').controls.map((c) => c.kind)).toEqual([
      'toggle',
      'slider',
      'picker',
    ])
    expect(build(DeviceType.Humidifier, ['humidifier'], h({ action: 'idle' })).title.en).toBe(
      'Idle',
    )
    expect(build(DeviceType.Humidifier, ['humidifier'], h({ on: false })).state).toBe('off')
    expect(build(DeviceType.Humidifier, ['humidifier'], {}).state).toBe('unknown')
  })
})
