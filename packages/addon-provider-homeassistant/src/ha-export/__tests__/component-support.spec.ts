import { describe, expect, it } from 'vitest'
import {
  ComponentSupportTracker,
  intersectSupport,
  LEGACY_SUPPORT,
  parseComponentReport,
  supportSignature,
} from '../component-support.js'
import type { HaPlatform } from '../types.js'

const NATIVE: readonly HaPlatform[] = [
  'binary_sensor',
  'sensor',
  'image',
  'switch',
  'button',
  'select',
  'camera',
  'number',
  'alarm_control_panel',
  'cover',
  'climate',
  'lock',
]

function reported(platforms: readonly HaPlatform[], version = '0.4.0') {
  return {
    kind: 'reported' as const,
    report: { version, platforms: new Set(platforms) },
  }
}

describe('parseComponentReport', () => {
  it('reads the platform list the component announces', () => {
    const report = parseComponentReport({
      version: '0.4.0',
      platforms: ['sensor', 'cover', 'lock'],
    })

    expect(report?.version).toBe('0.4.0')
    expect(supportSignature(report?.platforms ?? new Set())).toBe('cover,lock,sensor')
  })

  it('drops a platform this hub does not know rather than refusing the report', () => {
    /**
     * The component ships on its own train and will build platforms this
     * hub cannot emit. Refusing the whole answer over one unknown name
     * would degrade every native entity on that installation.
     */
    const report = parseComponentReport({
      platforms: ['sensor', 'siren', 'text'],
    })

    expect(supportSignature(report?.platforms ?? new Set())).toBe('sensor')
  })

  it('refuses an answer with no platform list at all', () => {
    expect(parseComponentReport({ version: '0.4.0' })).toBeNull()
    expect(parseComponentReport({ platforms: [] })).toBeNull()
    expect(parseComponentReport('0.4.0')).toBeNull()
    expect(parseComponentReport(null)).toBeNull()
  })
})

describe('intersectSupport', () => {
  it('keeps only what every instance builds', () => {
    const both = intersectSupport([new Set<HaPlatform>(['sensor', 'cover']), LEGACY_SUPPORT])

    expect(both.has('cover')).toBe(false)
    expect(both.has('sensor')).toBe(true)
  })

  it('is the legacy set when nothing was asked about', () => {
    expect(supportSignature(intersectSupport([]))).toBe(supportSignature(LEGACY_SUPPORT))
  })
})

describe('ComponentSupportTracker', () => {
  it('assumes the legacy platforms until something answers', () => {
    const tracker = new ComponentSupportTracker()

    expect(tracker.supportFor('ha_1').has('cover')).toBe(false)
    expect(tracker.supportFor('ha_1').has('sensor')).toBe(true)
  })

  it('applies an upgrade on the first read', () => {
    const tracker = new ComponentSupportTracker()

    const change = tracker.observe('ha_1', reported(NATIVE))

    expect(change.changed).toBe(true)
    expect(change.support.has('cover')).toBe(true)
    expect(tracker.supportFor('ha_1').has('lock')).toBe(true)
  })

  it('WITHHOLDS a downgrade until a second read agrees', () => {
    /**
     * D49. Losing `cover` migrates every native cover back to three
     * sensors, taking the entity ids, the history and every automation
     * pointing at them. One bad answer — a proxy 404, a restart
     * mid-request — must not be able to do that.
     */
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))

    const first = tracker.observe('ha_1', { kind: 'absent' })
    expect(first.changed).toBe(false)
    expect(first.withheldDowngrade).toBe(true)
    expect(tracker.supportFor('ha_1').has('cover')).toBe(true)

    const second = tracker.observe('ha_1', { kind: 'absent' })
    expect(second.changed).toBe(true)
    expect(tracker.supportFor('ha_1').has('cover')).toBe(false)
  })

  it('cancels a withheld downgrade when the next read agrees with what is in force', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))
    tracker.observe('ha_1', { kind: 'absent' })

    tracker.observe('ha_1', reported(NATIVE))
    const afterRecovery = tracker.observe('ha_1', { kind: 'absent' })

    expect(afterRecovery.withheldDowngrade).toBe(true)
    expect(tracker.supportFor('ha_1').has('cover')).toBe(true)
  })

  it('treats a network failure as no information at all', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))

    const change = tracker.observe('ha_1', {
      kind: 'unknown',
      error: 'timeout',
    })

    expect(change.changed).toBe(false)
    expect(change.withheldDowngrade).toBe(false)
    expect(tracker.supportFor('ha_1').has('cover')).toBe(true)
  })

  it('does not let a timeout break up two agreeing downgrade reads', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))
    tracker.observe('ha_1', { kind: 'absent' })

    tracker.observe('ha_1', { kind: 'unknown', error: 'timeout' })
    const change = tracker.observe('ha_1', { kind: 'absent' })

    expect(change.changed).toBe(true)
  })

  it('applies each further upgrade immediately — adding is never destructive', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))

    const change = tracker.observe('ha_1', reported([...NATIVE, 'fan', 'vacuum']))

    expect(change.changed).toBe(true)
    expect(change.support.has('fan')).toBe(true)
  })

  it('withholds even the FIRST report when it builds less than every released component', () => {
    /**
     * The starting point is not "nothing known", it is the set every
     * released component builds. A first answer that drops one of those is
     * still a downgrade — and on first contact it is exactly as likely to
     * be a proxy in front of Home Assistant answering for it.
     */
    const tracker = new ComponentSupportTracker()

    const first = tracker.observe('ha_1', reported(['sensor', 'cover']))

    expect(first.withheldDowngrade).toBe(true)
    expect(tracker.supportFor('ha_1').has('switch')).toBe(true)
    expect(tracker.observe('ha_1', reported(['sensor', 'cover'])).changed).toBe(true)
  })

  it('negotiates per broker, and intersects for a device both receive', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_new', reported(NATIVE))
    tracker.observe('ha_old', { kind: 'absent' })

    expect(tracker.supportForAll(['ha_new']).has('cover')).toBe(true)
    expect(tracker.supportForAll(['ha_new', 'ha_old']).has('cover')).toBe(false)
  })

  it('forgets a broker that stopped being exported to', () => {
    const tracker = new ComponentSupportTracker()
    tracker.observe('ha_1', reported(NATIVE))

    tracker.forget('ha_1')

    expect(tracker.supportFor('ha_1').has('cover')).toBe(false)
  })
})
