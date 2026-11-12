import { describe, expect, it } from 'vitest'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { actionsOf, build, methods, primaryOf, rowOf } from './hero-test-kit.js'

const fan = (extra: object = {}) => ({
  'fan-control': {
    speed: 60,
    preset: 'Nature',
    availablePresets: ['Normal', 'Nature'],
    direction: null,
    oscillating: true,
    lastChangedAt: 0,
    ...extra,
  },
})

describe('fan-control', () => {
  const caps = ['fan-control']
  it('spinning: running, speed on the scene, a slider, a preset picker and an oscillate toggle', () => {
    const m = build(DeviceType.Fan, caps, fan())
    expect(m.state).toBe('running')
    expect(m.scene).toMatchObject({ id: 'fan', level: 0.6 })
    expect(m.look.animation).toBe('spin')
    expect(rowOf(m, 'fan').controls.map((c) => c.kind)).toEqual(['slider', 'picker', 'toggle'])
    expect(rowOf(m, 'fan').status?.en).toBe('Speed 60% · Nature')
    expect(m.facts.map((f) => f.id)).toEqual(['speed'])
  })
  it('speed 0 is off; no speed is unknown and the slider has no value', () => {
    expect(build(DeviceType.Fan, caps, fan({ speed: 0 })).state).toBe('off')
    const m = build(DeviceType.Fan, caps, fan({ speed: null }), [DeviceFeature.FanSpeed])
    expect(m.state).toBe('unknown')
    expect(m.scene.level).toBeNull()
    expect(rowOf(m, 'fan').controls[0]).toMatchObject({ kind: 'slider', value: null })
  })
  it('direction shows when reported; an unread slice shows no control it cannot honour', () => {
    expect(
      rowOf(build(DeviceType.Fan, caps, fan({ direction: 'reverse' })), 'fan').controls.map((c) =>
        c.kind === 'action' ? c.action.id : c.id,
      ),
    ).toContain('fan.direction')
    const m = build(DeviceType.Fan, caps, {})
    expect(m.state).toBe('unknown')
    expect(rowOf(m, 'fan').controls).toEqual([])
  })
})

const vacuum = (state: string, extra: object = {}) => ({
  'vacuum-control': {
    state,
    batteryLevel: 64,
    fanSpeed: 'turbo',
    availableFanSpeeds: ['quiet', 'turbo'],
    progress: 40,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: 0,
    ...extra,
  },
})

describe('vacuum-control', () => {
  const caps = ['vacuum-control']
  it('cleaning: running, Pause is primary, progress and battery are facts', () => {
    const m = build(DeviceType.Vacuum, caps, vacuum('cleaning'))
    expect(m.state).toBe('running')
    expect(m.scene).toMatchObject({ id: 'vacuum', level: 0.4 })
    expect(primaryOf(m, 'vacuum')?.call.method).toBe('pause')
    expect(methods(m, 'vacuum')).toContain('returnToBase')
    expect(m.facts.map((f) => f.id)).toEqual(['battery', 'progress'])
    expect(rowOf(m, 'vacuum-suction').controls.map((c) => c.kind)).toEqual(['picker'])
    expect(rowOf(m, 'vacuum').controls.some((c) => c.kind === 'picker')).toBe(false)
  })
  it('paused resumes with start; docked and idle start; error only goes home', () => {
    const paused = build(DeviceType.Vacuum, caps, vacuum('paused'))
    expect(paused.state).toBe('standby')
    expect(primaryOf(paused, 'vacuum')?.call.method).toBe('start')
    expect(primaryOf(build(DeviceType.Vacuum, caps, vacuum('docked')), 'vacuum')?.call.method).toBe(
      'start',
    )
    const err = build(DeviceType.Vacuum, caps, vacuum('error', { errorLabel: 'Brush stuck' }))
    expect(err.state).toBe('alert')
    expect(err.title.en).toBe('Brush stuck')
    expect(actionsOf(rowOf(err, 'vacuum').controls).map((a) => a.call.method)).toEqual([
      'returnToBase',
      'locate',
    ])
  })
  it('the battery cap already speaks for the battery: no second fact', () => {
    const m = build(DeviceType.Vacuum, ['vacuum-control', 'battery'], vacuum('docked'))
    expect(m.facts.some((f) => f.id === 'battery')).toBe(false)
  })
  it('a battery the device did not report is not a fact; unread is unknown', () => {
    expect(build(DeviceType.Vacuum, caps, vacuum('docked', { batteryLevel: null })).facts).toEqual(
      [],
    )
    const m = build(DeviceType.Vacuum, caps, {})
    expect(m.state).toBe('unknown')
    expect(methods(m, 'vacuum')).toEqual(['start', 'pause', 'returnToBase'])
  })
})

const mower = (activity: string, extra: object = {}) => ({
  'lawn-mower-control': {
    activity,
    batteryLevel: 58,
    progress: 61,
    currentCode: null,
    currentCodeLabel: null,
    severity: 'info',
    lastChangedAt: 0,
    ...extra,
  },
})

describe('lawn-mower-control', () => {
  const caps = ['lawn-mower-control']
  it('mowing: running, Pause primary, Dock secondary, progress on the scene', () => {
    const m = build(DeviceType.LawnMower, caps, mower('mowing'))
    expect(m.state).toBe('running')
    expect(m.scene).toMatchObject({ id: 'lawn-mower', level: 0.61 })
    expect(primaryOf(m, 'mower')?.call.method).toBe('pause')
    expect(methods(m, 'mower')).toEqual(['pause', 'dock'])
  })
  it('paused resumes, docked starts, error docks and names its code', () => {
    expect(
      primaryOf(build(DeviceType.LawnMower, caps, mower('paused')), 'mower')?.call.method,
    ).toBe('startMowing')
    expect(build(DeviceType.LawnMower, caps, mower('docked')).state).toBe('idle')
    const err = build(DeviceType.LawnMower, caps, mower('error', { currentCodeLabel: 'Lifted' }))
    expect(err.state).toBe('alert')
    expect(err.title.en).toBe('Lifted')
    expect(methods(err, 'mower')).toEqual(['dock'])
  })
  it('unread is unknown with nothing guessed', () => {
    const m = build(DeviceType.LawnMower, caps, {})
    expect(m.state).toBe('unknown')
    expect(m.scene.level).toBeNull()
    expect(primaryOf(m, 'mower')).toBeUndefined()
  })
})

const feeder = (extra: object = {}) => ({
  'pet-feeder': {
    foodLevel: 3,
    bowlFood: null,
    eating: false,
    supportsMarkRefilled: false,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: 90,
    powerSource: 'battery',
    desiccantLeftDays: null,
    feeding: false,
    status: 'normal',
    error: null,
    errorCode: null,
    isDualHopper: false,
    childLock: false,
    indicatorLight: true,
    feedSound: true,
    volume: 5,
    lastFeedGrams: 12,
    lastFeedHopper1: null,
    lastFeedHopper2: null,
    lastFetchedAt: 0,
    ...extra,
  },
})

describe('pet-feeder', () => {
  const caps = ['pet-feeder']
  it('ready: Feed with the last portion is primary, call pet and child lock follow', () => {
    const m = build(DeviceType.PetFeeder, caps, feeder())
    expect(m.state).toBe('idle')
    expect(m.scene.id).toBe('pet-feeder')
    expect(primaryOf(m, 'feeder')).toMatchObject({
      label: { en: 'Feed 12 g' },
      call: { method: 'feed', args: { grams: 12 } },
    })
    expect(methods(m, 'feeder')).toEqual(['feed', 'callPet', 'setChildLock', 'setChildLock'])
  })
  it('no previous portion falls back to the hardware minimum; a dual hopper targets both', () => {
    expect(
      primaryOf(build(DeviceType.PetFeeder, caps, feeder({ lastFeedGrams: null })), 'feeder')?.call
        .args,
    ).toEqual({ grams: 4 })
    const dual = build(
      DeviceType.PetFeeder,
      caps,
      feeder({ isDualHopper: true, lastFeedHopper1: 10 }),
    )
    expect(primaryOf(dual, 'feeder')?.call.args).toEqual({ hopper1: 10, hopper2: 4 })
  })
  it('dispensing offers Cancel; a fault is an alert; offline is offline; low food waits', () => {
    const feeding = build(DeviceType.PetFeeder, caps, feeder({ feeding: true }))
    expect(feeding.state).toBe('running')
    expect(primaryOf(feeding, 'feeder')?.call.method).toBe('cancelFeed')
    expect(build(DeviceType.PetFeeder, caps, feeder({ error: 'Jam' })).state).toBe('alert')
    expect(build(DeviceType.PetFeeder, caps, feeder({ status: 'offline' })).state).toBe('offline')
    const low = build(DeviceType.PetFeeder, caps, feeder({ lowFood: true }))
    expect(low.state).toBe('standby')
    expect(low.facts.some((f) => f.tone === 'warning')).toBe(true)
  })
  it('unread is unknown and offers nothing', () => {
    const m = build(DeviceType.PetFeeder, caps, {})
    expect(m.state).toBe('unknown')
    expect(rowOf(m, 'feeder').controls).toEqual([])
  })
})

const fountain = (extra: object = {}) => ({
  'pet-fountain': {
    waterLevel: 70,
    waterVolume: null,
    empty: false,
    pumpRunning: true,
    error: null,
    lastFetchedAt: 0,
    ...extra,
  },
})

describe('pet-fountain', () => {
  const caps = ['pet-fountain', 'pump-cycle']
  it('pump running: running, water level on the scene, the pump toggle is on', () => {
    const m = build(DeviceType.PetFountain, caps, fountain())
    expect(m.state).toBe('running')
    expect(m.scene).toMatchObject({ id: 'pet-fountain', level: 0.7 })
    expect(rowOf(m, 'fountain').controls[0]).toMatchObject({ kind: 'toggle', on: true })
    expect(m.look.background).toBe('water')
  })
  it('pump off is off; an empty tank or a fault is an alert; a low level warns', () => {
    expect(build(DeviceType.PetFountain, caps, fountain({ pumpRunning: false })).state).toBe('off')
    const empty = build(DeviceType.PetFountain, caps, fountain({ empty: true }))
    expect(empty.state).toBe('alert')
    expect(empty.title.en).toBe('Tank empty')
    expect(build(DeviceType.PetFountain, caps, fountain({ error: 'Clogged' })).state).toBe('alert')
    expect(build(DeviceType.PetFountain, caps, fountain({ waterLevel: 10 })).facts[0]?.tone).toBe(
      'warning',
    )
  })
  it('a pump that has not reported is unknown, not off; unread has no toggle', () => {
    const m = build(DeviceType.PetFountain, caps, fountain({ pumpRunning: null }))
    expect(m.state).toBe('unknown')
    expect(rowOf(m, 'fountain').controls[0]).toMatchObject({ on: null })
    expect(rowOf(build(DeviceType.PetFountain, caps, {}), 'fountain').controls).toEqual([])
  })
})

describe('pump-cycle', () => {
  const caps = ['pet-fountain', 'pump-cycle']
  const cycle = (extra: object = {}) => ({
    'pump-cycle': { enabled: true, onTime: 300, offTime: 600, lastFetchedAt: 0, ...extra },
  })
  it('cycling says the minutes (the cap reports seconds); off says continuous', () => {
    const on = build(DeviceType.PetFountain, caps, cycle())
    expect(rowOf(on, 'pump-cycle').status?.en).toBe('Cycling · 5 min on · 10 min off')
    expect(rowOf(on, 'pump-cycle').controls[0]).toMatchObject({ kind: 'toggle', on: true })
    const off = build(DeviceType.PetFountain, caps, cycle({ enabled: false }))
    expect(rowOf(off, 'pump-cycle').status?.en).toBe('Runs continuously')
  })
  it('unread: unknown, never "continuous"', () => {
    const m = build(DeviceType.PetFountain, caps, cycle({ enabled: null }))
    expect(rowOf(m, 'pump-cycle').status?.en).toBe('—')
    expect(rowOf(m, 'pump-cycle').controls[0]).toMatchObject({ on: null })
  })
})
