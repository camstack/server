import { describe, it, expect } from 'vitest'
import { RembWatch, judgeCapacity } from '../climb-capacity.js'

const MARGIN = 1.2

describe('judgeCapacity — is there evidence the link has room for the next rung?', () => {
  it('the probe clears a KNOWN next rung: sufficient, whatever REMB says', () => {
    expect(
      judgeCapacity({ rembKbps: 480, probeKbps: 40_000, probeFresh: true }, 'mid', 1_800, MARGIN),
    ).toEqual({
      kind: 'sufficient',
      source: 'probe',
      kbps: 40_000,
      neededKbps: 2_160,
    })
  })

  it('an UNKNOWN next rung is judged against the client ladder threshold (mid 2.5 Mbps, high 8 Mbps)', () => {
    expect(
      judgeCapacity({ rembKbps: 480, probeKbps: 40_000, probeFresh: true }, 'mid', null, MARGIN)
        .kind,
    ).toBe('sufficient')
    expect(
      judgeCapacity({ rembKbps: null, probeKbps: 6_000, probeFresh: true }, 'high', null, MARGIN),
    ).toEqual({
      kind: 'probe-short',
      kbps: 6_000,
      neededKbps: 8_000,
    })
  })

  it('REMB is evidence FOR room, never against it — it is capped by what is sent', () => {
    expect(
      judgeCapacity({ rembKbps: 2_500, probeKbps: null, probeFresh: true }, 'mid', 1_800, MARGIN)
        .kind,
    ).toBe('sufficient')
    // 480 kbps of REMB on a 41 kbps rung says nothing about whether mid fits.
    expect(
      judgeCapacity({ rembKbps: 480, probeKbps: null, probeFresh: true }, 'mid', 1_800, MARGIN),
    ).toEqual({
      kind: 'none',
      bestKbps: 480,
      neededKbps: 2_160,
    })
  })

  it('a MEASURED probe below the bar is evidence against', () => {
    expect(
      judgeCapacity({ rembKbps: 480, probeKbps: 1_400, probeFresh: true }, 'mid', 1_800, MARGIN)
        .kind,
    ).toBe('probe-short')
  })

  it('nothing known is none (unknown), never "short" (D315)', () => {
    expect(
      judgeCapacity({ rembKbps: null, probeKbps: null, probeFresh: true }, 'mid', null, MARGIN),
    ).toEqual({
      kind: 'none',
      bestKbps: null,
      neededKbps: 2_500,
    })
  })
})

describe('RembWatch — werift keeps the last REMB forever; a value that stopped changing is unknown (m5)', () => {
  it('passes a moving estimate, and goes unknown once it has not changed for 30 s', () => {
    const w = new RembWatch(30_000)
    expect(w.read(480, 0)).toBe(480)
    expect(w.read(470, 2_000)).toBe(470)
    expect(w.read(470, 31_999)).toBe(470)
    expect(w.read(470, 32_001)).toBeNull()
    expect(w.read(475, 34_000)).toBe(475)
    expect(w.read(null, 36_000)).toBeNull()
  })
})
