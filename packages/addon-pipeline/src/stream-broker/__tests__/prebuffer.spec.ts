import { describe, expect, it } from 'vitest'
import {
  capPreRollRequestMs,
  DEFAULT_PREBUFFER_SEC,
  PREBUFFER_MAX_SEC,
  prebufferRetentionMs,
  resolvePrebuffer,
} from '../prebuffer.js'

/**
 * D381 — ONE prebuffer. `enabled` says whether to hold history at all,
 * `seconds` says how much, and nothing outside the broker writes either.
 *
 * These tests exist because the shape they pin is the one that was WRONG:
 * six knobs meaning three things, two of them (`detectionPreRollMs`,
 * `recordingPreRollMs`) configured by consumers of the ring rather than by
 * its owner.
 */
describe('resolvePrebuffer — one configuration, resolved in one place', () => {
  const base = { camStreamId: 'native:main', clusterSeconds: DEFAULT_PREBUFFER_SEC }

  it('ships the cluster seconds on a default-warm (high) mains stream', () => {
    expect(resolvePrebuffer({ ...base, defaultWarm: true })).toEqual({
      enabled: true,
      seconds: DEFAULT_PREBUFFER_SEC,
    })
  })

  it('is OFF on a stream that is not default-warm', () => {
    expect(resolvePrebuffer({ ...base, defaultWarm: false })).toEqual({
      enabled: false,
      seconds: 0,
    })
  })

  /**
   * The rule D193 put in `resolveRecordingPreRollMs` — "the question is what
   * this camera IS, not what it is doing" — lives HERE now, once, on the one
   * decision. It used to be stated in three places (`isDefaultWarm`,
   * `getEffectivePreBufferSec`, `resolveRecordingPreRollMs`).
   */
  it('is OFF by default on a battery camera, even on its high profile', () => {
    expect(resolvePrebuffer({ ...base, defaultWarm: true, batteryOperated: true })).toEqual({
      enabled: false,
      seconds: 0,
    })
  })

  it('is OFF by default on a pull-http terminal relay', () => {
    expect(resolvePrebuffer({ ...base, defaultWarm: true, terminalRelay: true })).toEqual({
      enabled: false,
      seconds: 0,
    })
  })

  it('honours an explicit operator override over every default, both ways', () => {
    expect(
      resolvePrebuffer({
        ...base,
        defaultWarm: false,
        batteryOperated: true,
        overrides: { 'native:main': { enabled: true, seconds: 8 } },
      }),
    ).toEqual({ enabled: true, seconds: 8 })
    expect(
      resolvePrebuffer({
        ...base,
        defaultWarm: true,
        overrides: { 'native:main': { enabled: false, seconds: 8 } },
      }),
    ).toEqual({ enabled: false, seconds: 0 })
  })

  it('clamps the seconds to the ceiling and never below one second', () => {
    expect(resolvePrebuffer({ ...base, defaultWarm: true, clusterSeconds: 9999 }).seconds).toBe(
      PREBUFFER_MAX_SEC,
    )
    expect(resolvePrebuffer({ ...base, defaultWarm: true, clusterSeconds: 0.1 }).seconds).toBe(1)
  })

  it('falls back to the shipped default when the cluster setting was never read', () => {
    expect(resolvePrebuffer({ camStreamId: 'native:main', defaultWarm: true }).seconds).toBe(
      DEFAULT_PREBUFFER_SEC,
    )
  })

  it('an enabled prebuffer with no seconds is not a prebuffer — it is off', () => {
    expect(
      resolvePrebuffer({
        ...base,
        defaultWarm: false,
        overrides: { 'native:main': { enabled: true, seconds: 0 } },
      }),
    ).toEqual({ enabled: false, seconds: 0 })
  })
})

describe('prebufferRetentionMs — the retention IS the prebuffer', () => {
  it('is the configured seconds while on, and zero while off', () => {
    expect(prebufferRetentionMs({ enabled: true, seconds: 5 })).toBe(5000)
    expect(prebufferRetentionMs({ enabled: false, seconds: 5 })).toBe(0)
  })
})

describe('capPreRollRequestMs — a consumer ASKS, the ring ANSWERS', () => {
  it('caps the request at what is actually retained', () => {
    expect(capPreRollRequestMs(15_000, 5_000)).toBe(5_000)
  })

  it('gives a modest request exactly what it asked for', () => {
    expect(capPreRollRequestMs(2_000, 5_000)).toBe(2_000)
  })

  it('answers nothing when nothing is retained, whatever was asked', () => {
    expect(capPreRollRequestMs(15_000, 0)).toBe(0)
  })

  /**
   * ZERO IS ZERO (D382). It used to be the case that an omitted request meant
   * "everything you have" — the shape that handed every detection dial on the
   * fleet a window nobody had decided it should have. The parameter is required
   * now, so a caller cannot omit it, and the value that stands for "I did not
   * ask" resolves to nothing.
   */
  it('serves nothing to a consumer that asked for nothing', () => {
    expect(capPreRollRequestMs(0, 5_000)).toBe(0)
  })

  it('refuses a nonsense request rather than turning it into a wide one', () => {
    expect(capPreRollRequestMs(Number.NaN, 5_000)).toBe(0)
    expect(capPreRollRequestMs(-1, 5_000)).toBe(0)
  })
})
