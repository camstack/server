import { describe, expect, it } from 'vitest'
import {
  type InboundVideoCounters,
  LandWatch,
  isLandMessage,
  recoveryDeltas,
} from '../playback-stats'

const counters = (over: Partial<InboundVideoCounters>): InboundVideoCounters => ({
  framesReceived: 0,
  framesDecoded: 0,
  framesDropped: 0,
  keyFramesDecoded: 0,
  pliCount: 0,
  nackCount: 0,
  firCount: 0,
  packetsLost: 0,
  jitterBufferDelay: 0,
  jitterBufferEmittedCount: 0,
  ...over,
})

describe('recoveryDeltas', () => {
  it('reports each loss-recovery counter as a per-window delta', () => {
    const d = recoveryDeltas(
      counters({ keyFramesDecoded: 2, pliCount: 1, nackCount: 5, firCount: 0, packetsLost: 3 }),
      counters({ keyFramesDecoded: 3, pliCount: 4, nackCount: 9, firCount: 2, packetsLost: 10 }),
    )
    expect(d).toMatchObject({
      dKeyFramesDecoded: 1,
      dPli: 3,
      dNack: 4,
      dFir: 2,
      dPacketsLost: 7,
    })
  })

  it('windows the jitter-buffer delay instead of averaging since the start', () => {
    const d = recoveryDeltas(
      counters({ jitterBufferDelay: 10, jitterBufferEmittedCount: 100 }),
      counters({ jitterBufferDelay: 12, jitterBufferEmittedCount: 120 }),
    )
    // 2 s of delay over 20 emitted frames = 100 ms this window.
    expect(d.windowJitterMs).toBe(100)
    expect(
      recoveryDeltas(
        counters({ jitterBufferEmittedCount: 5 }),
        counters({ jitterBufferEmittedCount: 5 }),
      ).windowJitterMs,
    ).toBe(0)
  })
})

describe('isLandMessage', () => {
  it('recognises the server playing/paused state and nothing else', () => {
    expect(isLandMessage('{"t":"state","state":"playing"}')).toBe(true)
    expect(isLandMessage('{"t":"state","state":"paused"}')).toBe(true)
    expect(isLandMessage('{"t":"state","state":"gap"}')).toBe(false)
    expect(isLandMessage('{"t":"pos","epochMs":1}')).toBe(false)
    expect(isLandMessage('not json')).toBe(false)
    expect(isLandMessage(new ArrayBuffer(2))).toBe(false)
  })
})

describe('LandWatch', () => {
  it('measures the time from the land to the first poll where framesDecoded advances', () => {
    const w = new LandWatch()
    w.mark(1_000, 50)
    expect(w.observe(1_500, 50, 3, 30_000)).toBeNull()
    expect(w.observe(6_200, 50, 3, 30_000)).toBeNull()
    expect(w.observe(7_000, 51, 4, 30_000)).toEqual({
      msToFirstDecode: 6_000,
      keyFramesDecoded: 4,
      timedOut: false,
    })
    // Answers once per land.
    expect(w.observe(8_000, 90, 5, 30_000)).toBeNull()
    expect(w.active).toBe(false)
  })

  it('reports a timeout when nothing decodes', () => {
    const w = new LandWatch()
    w.mark(0, 10)
    expect(w.observe(30_000, 10, 1, 30_000)).toEqual({
      msToFirstDecode: null,
      keyFramesDecoded: 1,
      timedOut: true,
    })
  })
})
