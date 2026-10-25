/**
 * Liveness checks — the invariants that were false for four hours on
 * 2026-08-03 while every surface stayed quiet.
 *
 * The node ran with zero devices, zero published streams and zero recordings
 * from 16:28 to 20:28 UTC. Three separate defects caused it and all three were
 * silent by construction; each was fixed, and a log line added. This is the
 * check for the CLASS: assert the things that must be true, and say so when
 * they are not.
 *
 * Every check here is deliberately UNAMBIGUOUS. A liveness alert that fires on
 * a quiet night is an alert that gets ignored, and an ignored alert is worse
 * than none — so "no tracks recently" is NOT a check (a camera can legitimately
 * see nothing for hours), while "a camera that has been recording all day
 * stopped producing segments" is.
 */
import { describe, it, expect } from 'vitest'
import { evaluateLiveness, type LivenessFacts } from '../liveness-checks.js'

const NOW = 1_785_800_000_000
const MINUTE = 60_000

function facts(overrides: Partial<LivenessFacts> = {}): LivenessFacts {
  return {
    nowMs: NOW,
    deviceCount: 292,
    cameras: [],
    staleAfterMs: 15 * MINUTE,
    ...overrides,
  }
}

describe('evaluateLiveness — no devices', () => {
  it('fires when the node has no devices at all (the 2026-08-03 signature)', () => {
    const found = evaluateLiveness(facts({ deviceCount: 0 }))
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('liveness:no-devices')
    expect(found[0]!.severity).toBe('error')
    expect(found[0]!.message).toMatch(/no devices/i)
  })

  it('does not also complain about cameras when there are no devices — one cause, one alert', () => {
    const found = evaluateLiveness(
      facts({
        deviceCount: 0,
        cameras: [
          {
            deviceId: 101,
            online: false,
            lastSegmentMs: NOW - 4 * 60 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    expect(found.map((f) => f.id)).toEqual(['liveness:no-devices'])
  })

  it('is quiet on a healthy node', () => {
    expect(evaluateLiveness(facts())).toEqual([])
  })
})

describe('evaluateLiveness — every device offline', () => {
  it('fires when devices exist but not one is online', () => {
    const found = evaluateLiveness(
      facts({
        deviceCount: 3,
        cameras: [
          { deviceId: 101, online: false, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
          { deviceId: 102, online: false, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
        ],
      }),
    )
    expect(found.map((f) => f.id)).toContain('liveness:all-devices-offline')
  })

  it('stays quiet when at least one camera is online', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          { deviceId: 101, online: true, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
          { deviceId: 102, online: false, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
        ],
      }),
    )
    expect(found.map((f) => f.id)).not.toContain('liveness:all-devices-offline')
  })
})

describe('evaluateLiveness — footage stopped', () => {
  it('fires per camera that was recording and went quiet', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 60 * MINUTE,
            activeMode: 'continuous',
          },
          { deviceId: 102, online: true, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
        ],
      }),
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('liveness:no-footage:101')
    // Per-camera findings MUST carry the numeric id — a miss rate is always
    // asked per-camera, and a line without it cannot answer that.
    expect(found[0]!.deviceId).toBe(101)
    // Message prefers the operator name; bare id only when name is absent.
    expect(found[0]!.message).toContain('Camera 101')
  })

  it('names the camera in the message when a name is known (never prefer the id)', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 108,
            name: 'Kitchen',
            online: true,
            lastSegmentMs: NOW - 60 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    expect(found[0]!.message).toContain('Kitchen')
    expect(found[0]!.message).not.toContain('Camera 108')
    expect(found[0]!.deviceId).toBe(108)
  })

  it('says HOW LONG the camera has been quiet, not just that it is', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 47 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    expect(found[0]!.message).toMatch(/47/)
  })

  it('is quiet about an EVENTS-mode camera that saw a quiet night — silence is the scene, not the recorder', () => {
    // Seven cameras in `events` mode raised "Recording stopped" for up to
    // 18 hours on 2026-09-06: each had recorded one event the evening before
    // and then nothing moved. An events recorder that is silent is working.
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 1438,
            online: true,
            lastSegmentMs: NOW - 18 * 60 * MINUTE,
            activeMode: 'events',
          },
        ],
      }),
    )
    expect(found).toEqual([])
  })

  it('is quiet about a camera whose recording was switched OFF after it had footage', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          { deviceId: 1438, online: true, lastSegmentMs: NOW - 60 * MINUTE, activeMode: 'off' },
        ],
      }),
    )
    expect(found).toEqual([])
  })

  it('IGNORES a camera that has no footage at all — it simply does not record', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [{ deviceId: 106, online: true, lastSegmentMs: null, activeMode: 'continuous' }],
      }),
    )
    expect(found).toEqual([])
  })

  it('ignores an offline camera — being offline is its own, already-reported fact', () => {
    // A second, ONLINE camera keeps the all-offline rule out of the way, so
    // this asserts only what it means to: the offline camera's silence is not
    // reported a second time as "recording stopped".
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 101,
            online: false,
            lastSegmentMs: NOW - 60 * MINUTE,
            activeMode: 'continuous',
          },
          { deviceId: 102, online: true, lastSegmentMs: NOW - MINUTE, activeMode: 'continuous' },
        ],
      }),
    )
    expect(found).toEqual([])
  })

  it('does not fire inside the staleness window', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 14 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    expect(found).toEqual([])
  })

  it('reproduces the 2026-08-03 outage: three recorders quiet for ~4h', () => {
    const found = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 104,
            online: true,
            lastSegmentMs: NOW - 237 * MINUTE,
            activeMode: 'continuous',
          },
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 237 * MINUTE,
            activeMode: 'continuous',
          },
          {
            deviceId: 102,
            online: true,
            lastSegmentMs: NOW - 237 * MINUTE,
            activeMode: 'continuous',
          },
          { deviceId: 108, online: true, lastSegmentMs: null, activeMode: 'continuous' },
        ],
      }),
    )
    expect(found.map((f) => f.id)).toEqual([
      'liveness:no-footage:104',
      'liveness:no-footage:101',
      'liveness:no-footage:102',
    ])
    expect(found.every((f) => f.severity === 'error')).toBe(true)
  })

  it('ids are STABLE across ticks so an ongoing fault updates one alert, not a stream of them', () => {
    const a = evaluateLiveness(
      facts({
        cameras: [
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 30 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    const b = evaluateLiveness(
      facts({
        nowMs: NOW + 5 * MINUTE,
        cameras: [
          {
            deviceId: 101,
            online: true,
            lastSegmentMs: NOW - 30 * MINUTE,
            activeMode: 'continuous',
          },
        ],
      }),
    )
    expect(a[0]!.id).toBe(b[0]!.id)
  })
})
