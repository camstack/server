import { describe, expect, it } from 'vitest'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { build, methods, NOW, primaryOf, rowOf } from './hero-test-kit.js'

const lock = (state: string, extra: object = {}) => ({
  'lock-control': { state, lastChangedAt: NOW - 2 * 3_600_000, ...extra },
})

describe('lock-control', () => {
  const caps = ['lock-control']
  it('locked: a closed door, "Locked", Unlock is the primary and asks first', () => {
    const m = build(DeviceType.Lock, caps, lock('locked'))
    expect(m.state).toBe('on')
    expect(m.title.en).toBe('Locked')
    expect(m.scene).toMatchObject({ id: 'lock', mode: 'closed' })
    expect(m.look.icon).toBe('lock')
    expect(primaryOf(m, 'lock')).toMatchObject({
      call: { cap: 'lock-control', method: 'unlock' },
      confirm: 'unlock',
    })
    expect(rowOf(m, 'lock').status?.en).toBe('Locked · 2 h ago')
  })
  it('unlocked: an open door, "Unlocked", Lock is the primary', () => {
    const m = build(DeviceType.Lock, caps, lock('unlocked'))
    expect(m.state).toBe('standby')
    expect(m.title.en).toBe('Unlocked')
    expect(m.look.icon).toBe('lock-open')
    expect(m.scene.mode).toBe('open')
    expect(primaryOf(m, 'lock')?.call.method).toBe('lock')
  })
  it('door-open offers no lock (it is refused); jammed offers both; moving offers none', () => {
    expect(methods(build(DeviceType.Lock, caps, lock('door-open')), 'lock')).toEqual([])
    expect(methods(build(DeviceType.Lock, caps, lock('jammed')), 'lock')).toEqual([
      'unlock',
      'lock',
    ])
    expect(build(DeviceType.Lock, caps, lock('jammed')).state).toBe('alert')
    const moving = build(DeviceType.Lock, caps, lock('locking'))
    expect(moving.state).toBe('running')
    expect(methods(moving, 'lock')).toEqual([])
  })
  it('the latch release shows only when the lock declares it', () => {
    const f = [DeviceFeature.LockOpen]
    expect(methods(build(DeviceType.Lock, caps, lock('locked'), f), 'lock')).toContain('open')
    expect(methods(build(DeviceType.Lock, caps, lock('locked')), 'lock')).not.toContain('open')
  })
  it('unread is unknown, never locked or unlocked, and nothing is guessed', () => {
    const m = build(DeviceType.Lock, caps, {})
    expect(m.state).toBe('unknown')
    expect(m.title.en).toBe('Unknown')
    expect(m.scene.mode).toBeNull()
    expect(primaryOf(m, 'lock')).toBeUndefined()
    expect(methods(m, 'lock')).toEqual(['lock', 'unlock'])
    expect(build(DeviceType.Lock, caps, { 'lock-control': { state: 'bogus' } }).state).toBe(
      'unknown',
    )
  })
})

const alarm = (state: string, extra: object = {}) => ({
  'alarm-panel': {
    state,
    availableModes: ['home', 'away'],
    requiresCode: false,
    lastChangedAt: NOW - 600_000,
    ...extra,
  },
})

describe('alarm-panel', () => {
  const caps = ['alarm-panel']
  it('disarmed: off, one arm button per available mode, the first is primary', () => {
    const m = build(DeviceType.AlarmPanel, caps, alarm('disarmed'))
    expect(m.state).toBe('off')
    expect(m.title.en).toBe('Disarmed')
    expect(m.scene.id).toBe('alarm')
    expect(methods(m, 'alarm')).toEqual(['arm', 'arm'])
    expect(primaryOf(m, 'alarm')?.call.args).toEqual({ mode: 'home' })
  })
  it('armed: on with the mode in words, Disarm is the primary', () => {
    const m = build(DeviceType.AlarmPanel, caps, alarm('armed_away'))
    expect(m.state).toBe('on')
    expect(m.title.en).toBe('Armed away')
    expect(m.look.icon).toBe('shield-check')
    expect(primaryOf(m, 'alarm')?.call.method).toBe('disarm')
  })
  it('entry delay and arming wait (standby); triggered is an alert', () => {
    expect(build(DeviceType.AlarmPanel, caps, alarm('pending')).state).toBe('standby')
    expect(methods(build(DeviceType.AlarmPanel, caps, alarm('arming')), 'alarm')).toEqual([])
    const t = build(DeviceType.AlarmPanel, caps, alarm('triggered'))
    expect(t.state).toBe('alert')
    expect(t.look.icon).toBe('shield-alert')
    expect(primaryOf(t, 'alarm')?.call.method).toBe('disarm')
  })
  it('a panel that wants a code offers no button: a hero action carries no secret', () => {
    const m = build(DeviceType.AlarmPanel, caps, alarm('disarmed', { requiresCode: true }))
    expect(m.rows.find((r) => r.id === 'alarm')?.controls).toEqual([])
  })
  it('unread is unknown, never disarmed', () => {
    const m = build(DeviceType.AlarmPanel, caps, {})
    expect(m.state).toBe('unknown')
    expect(m.title.en).toBe('Unknown')
    expect(primaryOf(m, 'alarm')).toBeUndefined()
  })
})

describe('automation-control', () => {
  const caps = ['automation-control']
  const slice = (extra: object = {}) => ({
    'automation-control': {
      enabled: true,
      isRunning: false,
      lastTriggeredAt: NOW - 3_600_000,
      lastError: null,
      lastChangedAt: NOW,
      ...extra,
    },
  })
  it('enabled / disabled / running / failed', () => {
    expect(build(DeviceType.Automation, caps, slice()).state).toBe('on')
    expect(build(DeviceType.Automation, caps, slice({ enabled: false })).state).toBe('off')
    expect(build(DeviceType.Automation, caps, slice({ isRunning: true })).state).toBe('running')
    const failed = build(DeviceType.Automation, caps, slice({ lastError: 'boom' }))
    expect(failed.state).toBe('alert')
    expect(rowOf(failed, 'automation').status?.en).toContain('boom')
  })
  it('Run now is primary and the enable toggle reflects the slice', () => {
    const m = build(DeviceType.Automation, caps, slice({ enabled: false }))
    expect(m.scene.id).toBe('event-stream')
    expect(primaryOf(m, 'automation')?.call.method).toBe('trigger')
    const toggle = rowOf(m, 'automation').controls.find((c) => c.kind === 'toggle')
    expect(toggle).toMatchObject({ on: false })
  })
  it('unread is unknown and the toggle is not drawn as off', () => {
    const m = build(DeviceType.Automation, caps, {})
    expect(m.state).toBe('unknown')
    expect(rowOf(m, 'automation').controls.find((c) => c.kind === 'toggle')).toMatchObject({
      on: null,
    })
  })
})

describe('script-runner', () => {
  const caps = ['script-runner']
  const slice = (extra: object = {}) => ({
    'script-runner': {
      isRunning: false,
      lastRunAt: NOW - 120_000,
      lastRunSuccess: true,
      lastError: null,
      lastChangedAt: NOW,
      ...extra,
    },
  })
  it('ready offers Run; running offers Stop; a failed last run is an alert', () => {
    const ready = build(DeviceType.Script, caps, slice())
    expect(ready.state).toBe('idle')
    expect(primaryOf(ready, 'script')?.call.method).toBe('run')
    const running = build(DeviceType.Script, caps, slice({ isRunning: true }))
    expect(running.state).toBe('running')
    expect(primaryOf(running, 'script')?.call.method).toBe('stop')
    expect(build(DeviceType.Script, caps, slice({ lastRunSuccess: false })).state).toBe('alert')
  })
  it('a script that never ran says nothing about when', () => {
    const m = build(DeviceType.Script, caps, slice({ lastRunAt: 0, lastRunSuccess: null }))
    expect(m.facts).toEqual([])
    expect(m.state).toBe('idle')
  })
  it('unread is unknown', () => {
    expect(build(DeviceType.Script, caps, {}).state).toBe('unknown')
  })
})

describe('do-not-disturb', () => {
  const caps = ['media-player', 'do-not-disturb']
  it('is a toggle row on a media player, with the three states', () => {
    for (const [enabled, on] of [
      [true, true],
      [false, false],
      [null, null],
    ] as const) {
      const m = build(DeviceType.MediaPlayer, caps, {
        'do-not-disturb': { enabled, lastChangedAt: 0 },
      })
      expect(rowOf(m, 'do-not-disturb').controls[0]).toMatchObject({ kind: 'toggle', on })
    }
  })
  it('unread: the toggle is unknown, not off', () => {
    const m = build(DeviceType.MediaPlayer, caps, {})
    expect(rowOf(m, 'do-not-disturb').status?.en).toBe('Unknown')
    expect(rowOf(m, 'do-not-disturb').controls[0]).toMatchObject({ on: null })
  })
})
