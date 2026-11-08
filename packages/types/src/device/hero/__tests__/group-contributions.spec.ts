import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { build, NOW } from './hero-test-kit.js'

describe('group-active', () => {
  it('active / inactive, in the group words, not On / Off', () => {
    const on = build(DeviceType.Cover, ['group-active'], {
      'group-active': { active: true, lastChangedAt: 0 },
    })
    expect(on.state).toBe('on')
    expect(on.title.en).toBe('Active')
    const off = build(DeviceType.Cover, ['group-active'], {
      'group-active': { active: false, lastChangedAt: 0 },
    })
    expect(off.state).toBe('off')
    expect(off.title.en).toBe('Inactive')
  })
  it('unread is unknown, never inactive', () => {
    expect(build(DeviceType.Cover, ['group-active'], {}).state).toBe('unknown')
  })
  it("a member cap's own reading outranks the group's", () => {
    const m = build(DeviceType.Lock, ['group-active', 'lock-control'], {
      'group-active': { active: false, lastChangedAt: 0 },
      'lock-control': { state: 'locked', lastChangedAt: 0 },
    })
    expect(m.title.en).toBe('Locked')
  })
})

describe('group-status', () => {
  it('all members reporting: a muted count; some excluded: a warning', () => {
    const all = build(DeviceType.Light, ['group-status'], {
      'group-status': { included: 4, excluded: 0, total: 4 },
    })
    expect(all.facts[0]).toMatchObject({ id: 'members', tone: 'muted' })
    expect(all.facts[0]?.text.en).toBe('4 members')
    const part = build(DeviceType.Light, ['group-status'], {
      'group-status': { included: 3, excluded: 1, total: 4 },
    })
    expect(part.facts[0]).toMatchObject({ tone: 'warning' })
    expect(part.facts[0]?.text.en).toBe('3 of 4 reporting')
  })
  it('unread says nothing about the members', () => {
    expect(build(DeviceType.Light, ['group-status'], {}).facts).toEqual([])
  })
})

describe('group-commands', () => {
  const result = (ok: boolean) => ({ deviceId: 1, cap: 'switch', method: 'setState', ok, at: NOW })
  it('a fan-out that failed on members says so; a clean one is silent', () => {
    const bad = build(DeviceType.Switch, ['group-commands'], {
      'group-commands': { results: [result(true), result(false), result(false)] },
    })
    expect(bad.facts[0]).toMatchObject({ id: 'failures', tone: 'danger' })
    expect(bad.facts[0]?.text.en).toBe('2 of 3 failed')
    expect(
      build(DeviceType.Switch, ['group-commands'], {
        'group-commands': { results: [result(true)] },
      }).facts,
    ).toEqual([])
  })
  it('unread is silent, not "all good"', () => {
    expect(build(DeviceType.Switch, ['group-commands'], {}).facts).toEqual([])
  })
})

describe('event-emitter', () => {
  const slice = (lastEvent: object | null) => ({
    'event-emitter': { eventTypes: ['ring'], lastEvent, eventCountSinceStart: 12 },
  })
  it('listens; names the last event and when, and counts them', () => {
    const m = build(
      DeviceType.EventEmitter,
      ['event-emitter'],
      slice({
        deviceId: 7,
        eventType: 'ring',
        data: null,
        timestamp: NOW - 300_000,
        seq: 12,
      }),
    )
    expect(m.state).toBe('idle')
    expect(m.title.en).toBe('Listening')
    expect(m.scene.id).toBe('event-stream')
    expect(m.facts[0]?.text.en).toBe('ring · 5 min ago')
    expect(m.sideTiles.right[0]?.value.en).toBe('12')
  })
  it('never fired: listening with no event fact; unread is unknown', () => {
    expect(build(DeviceType.EventEmitter, ['event-emitter'], slice(null)).facts).toEqual([])
    expect(build(DeviceType.EventEmitter, ['event-emitter'], {}).state).toBe('unknown')
  })
})
