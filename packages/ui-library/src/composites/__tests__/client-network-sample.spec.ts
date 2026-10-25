import { describe, it, expect } from 'vitest'
import { nextClientSample, type InboundReading } from '../client-network-sample.js'

const pcA = {}
const pcB = {}
const at = (pc: object, bytes: number, ts: number, recv = 0, lost = 0): InboundReading => ({
  pc,
  lost,
  recv,
  bytes,
  ts,
  rttS: 0.004,
  jitterS: 0.001,
})

describe('nextClientSample — what the player reports to the broker every 2 s', () => {
  it('reports the byte rate between two readings of the SAME peer connection', () => {
    const first = nextClientSample(null, at(pcA, 0, 0), { renegotiating: false, probe: null })
    expect(first.sample).toBeNull()
    const second = nextClientSample(first.baseline, at(pcA, 10_250, 2_000, 100), {
      renegotiating: false,
      probe: null,
    })
    expect(second.sample?.estimatedBandwidthKbps).toBe(41)
  })

  /**
   * I1 (review): the reporter kept its byte baseline across a PC swap, so the
   * first reading of the NEW PC (fewer bytes than the old one had) clamped to
   * 0 kbps — a zero the broker matched against real sends.
   */
  it('a new peer connection RESETS the baseline: no sample, never a clamped zero', () => {
    const base = nextClientSample(null, at(pcA, 5_000_000, 10_000), {
      renegotiating: false,
      probe: null,
    })
    const swapped = nextClientSample(base.baseline, at(pcB, 60_000, 12_000), {
      renegotiating: false,
      probe: null,
    })
    expect(swapped.sample).toBeNull()
    const next = nextClientSample(swapped.baseline, at(pcB, 120_000, 14_000), {
      renegotiating: false,
      probe: null,
    })
    expect(next.sample?.estimatedBandwidthKbps).toBe(240)
  })

  it('reports nothing while a renegotiation is in flight, and re-baselines after it', () => {
    const base = nextClientSample(null, at(pcA, 0, 0), { renegotiating: false, probe: null })
    const during = nextClientSample(base.baseline, at(pcA, 1_000, 2_000), {
      renegotiating: true,
      probe: null,
    })
    expect(during.sample).toBeNull()
    expect(during.baseline).toBeNull()
  })

  it('carries the latest probe, whatever it read, with its age (I4)', () => {
    const base = nextClientSample(null, at(pcA, 0, 0), { renegotiating: false, probe: null })
    const s = nextClientSample(base.baseline, at(pcA, 10_000, 2_000), {
      renegotiating: false,
      probe: { mbps: 1.2, ageMs: 4_000 },
    })
    expect(s.sample).toMatchObject({ downlinkMbps: 1.2, downlinkAgeMs: 4_000 })
    const none = nextClientSample(s.baseline, at(pcA, 20_000, 4_000), {
      renegotiating: false,
      probe: null,
    })
    expect(none.sample).not.toHaveProperty('downlinkMbps')
  })
})
