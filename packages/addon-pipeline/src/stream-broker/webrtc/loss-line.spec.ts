import { describe, expect, it } from 'vitest'
import {
  LOSS_HEARTBEAT_TICKS,
  LOSS_MOVE_PCT,
  shouldWriteLossLine,
  type LossSample,
} from './loss-line.js'

const reporting = (lossPct: number): LossSample => ({ hasReceiverReport: true, lossPct })
const silent: LossSample = { hasReceiverReport: false, lossPct: -1 }

describe('shouldWriteLossLine', () => {
  it('always writes the FIRST line of a session', () => {
    const d = shouldWriteLossLine({ sample: reporting(0), lastWritten: null, ticksSinceWrite: 0 })
    expect(d).toEqual({ write: true, reason: 'first' })
  })

  it('writes the moment a peer STARTS reporting — that is the diagnosis', () => {
    // "Does the Echo send receiver reports at all?" is the question the whole
    // adaptive plan hangs on. The transition must never be throttled away.
    const d = shouldWriteLossLine({
      sample: reporting(0),
      lastWritten: silent,
      ticksSinceWrite: 1,
    })
    expect(d).toEqual({ write: true, reason: 'reporting-changed' })
  })

  it('writes the moment a peer STOPS reporting', () => {
    const d = shouldWriteLossLine({ sample: silent, lastWritten: reporting(0), ticksSinceWrite: 1 })
    expect(d.write).toBe(true)
    expect(d.reason).toBe('reporting-changed')
  })

  it('writes when loss MOVES, so a degradation is not averaged away', () => {
    const d = shouldWriteLossLine({
      sample: reporting(LOSS_MOVE_PCT),
      lastWritten: reporting(0),
      ticksSinceWrite: 1,
    })
    expect(d.reason).toBe('loss-moved')
    // …and when it recovers, too — a drop back to healthy is news.
    expect(
      shouldWriteLossLine({
        sample: reporting(0),
        lastWritten: reporting(8),
        ticksSinceWrite: 1,
      }).reason,
    ).toBe('loss-moved')
  })

  it('stays QUIET while nothing moves', () => {
    const d = shouldWriteLossLine({
      sample: reporting(0.5),
      lastWritten: reporting(0),
      ticksSinceWrite: 2,
    })
    expect(d).toEqual({ write: false, reason: 'quiet' })
  })

  it('beats a heartbeat so a healthy session still proves it is alive', () => {
    const d = shouldWriteLossLine({
      sample: reporting(0),
      lastWritten: reporting(0),
      ticksSinceWrite: LOSS_HEARTBEAT_TICKS,
    })
    expect(d).toEqual({ write: true, reason: 'heartbeat' })
  })

  it('a session that reports NOTHING still beats the heartbeat', () => {
    // Silence must be visible. A session producing no line at all reads as a
    // session that never ran.
    const d = shouldWriteLossLine({
      sample: silent,
      lastWritten: silent,
      ticksSinceWrite: LOSS_HEARTBEAT_TICKS,
    })
    expect(d.write).toBe(true)
  })
})
