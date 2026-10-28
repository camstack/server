import { describe, expect, it } from 'vitest'
import { BATTERY_UNREACHABLE_AFTER_MS } from '@camstack/types'
import {
  WAKE_DEMAND_BOUND_MS,
  isStreamOutageReason,
  judgeStaleStream,
} from '../stream-broker/stream-health-policy.js'

const NOW = 1_800_000_000_000

describe('judgeStaleStream (D883)', () => {
  it('a mains camera that lost its stream is an outage, unchanged', () => {
    expect(judgeStaleStream({ battery: null, demanded: false, nowMs: NOW })).toEqual({
      kind: 'outage',
      reason: 'stale-timeout',
    })
  })

  it('a sleeping battery camera nobody asked for is NOT an outage', () => {
    const verdict = judgeStaleStream({
      battery: { facts: { sleeping: true, lastContactAt: NOW - 60_000 } },
      demanded: false,
      nowMs: NOW,
    })
    expect(verdict).toEqual({ kind: 'suppressed', presence: 'sleeping' })
  })

  it('a demanded wake that delivered nothing is a wake-timeout', () => {
    expect(
      judgeStaleStream({
        battery: { facts: { sleeping: true, lastContactAt: NOW - 1_000 } },
        demanded: true,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'outage', reason: 'wake-timeout' })
  })

  it('a connection error while the camera is reported awake is an outage', () => {
    expect(
      judgeStaleStream({
        battery: { facts: { sleeping: false } },
        demanded: false,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'outage', reason: 'connection-error' })
  })

  it('a camera that JUST woke and has no keyframe yet is not a fault (wake window)', () => {
    expect(
      judgeStaleStream({
        battery: { facts: { sleeping: false, awakeSince: NOW - 500 } },
        demanded: false,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'suppressed', presence: 'awake' })
  })

  it('awake past the wake bound with no stream is a connection-error', () => {
    expect(
      judgeStaleStream({
        battery: { facts: { sleeping: false, awakeSince: NOW - WAKE_DEMAND_BOUND_MS } },
        demanded: false,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'outage', reason: 'connection-error' })
  })

  it('a mains camera is unchanged by awakeSince (battery null)', () => {
    expect(judgeStaleStream({ battery: null, demanded: false, nowMs: NOW })).toEqual({
      kind: 'outage',
      reason: 'stale-timeout',
    })
  })

  it('silence past the battery refresh window is battery-unreachable, demanded or not', () => {
    const facts = {
      sleeping: true,
      lastContactAt: NOW - BATTERY_UNREACHABLE_AFTER_MS - 1,
    }
    for (const demanded of [false, true]) {
      expect(judgeStaleStream({ battery: { facts }, demanded, nowMs: NOW })).toEqual({
        kind: 'outage',
        reason: 'battery-unreachable',
      })
    }
  })

  it('knows which reasons are outages', () => {
    expect(isStreamOutageReason('wake-timeout')).toBe(true)
    expect(isStreamOutageReason('suspended')).toBe(false)
    expect(isStreamOutageReason(undefined)).toBe(false)
  })
})
