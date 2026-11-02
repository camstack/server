/**
 * The ring DENIES `debug.*` lines unless somebody watches that device, so a
 * disabled channel never costs ring space.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { __resetDebugInterestForTests, getDebugInterest, type LogEntry } from '@camstack/types'
import { LogRingBuffer } from '../log-ring-buffer.js'

function line(
  channel: string | undefined,
  deviceId: number | undefined,
  message: string,
): LogEntry {
  return {
    timestamp: new Date(0),
    level: 'info',
    message,
    tags: {
      ...(channel === undefined ? {} : { logChannel: channel }),
      ...(deviceId === undefined ? {} : { deviceId }),
    },
  }
}

afterEach(() => {
  __resetDebugInterestForTests()
})

describe('LogRingBuffer debug.* denial', () => {
  it('refuses a debug line with no watch, and keeps every other line', () => {
    const ring = new LogRingBuffer(10)
    ring.push(line('debug.ptz', 7, 'dump'))
    ring.push(line('stream-broker.rtp', 7, 'diagnostic'))
    ring.push(line(undefined, undefined, 'plain'))
    expect(ring.getAll().map((e) => e.message)).toEqual(['plain', 'diagnostic'])
  })

  it('accepts it for the watched device only, and refuses it again when the watch lapses', () => {
    const ring = new LogRingBuffer(10)
    getDebugInterest().apply([{ channel: 'debug.ptz', armedUntilMs: 100, deviceIds: [7] }], 0)
    ring.push(line('debug.ptz', 7, 'mine'))
    ring.push(line('debug.ptz', 8, 'other device'))
    ring.push(line('debug.ptz', undefined, 'no device'))
    expect(ring.getAll().map((e) => e.message)).toEqual(['mine'])
    getDebugInterest().tick(100)
    ring.push(line('debug.ptz', 7, 'after lapse'))
    expect(ring.size()).toBe(1)
  })
})
