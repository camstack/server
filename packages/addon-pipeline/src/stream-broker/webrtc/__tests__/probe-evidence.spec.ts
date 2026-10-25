import { describe, it, expect } from 'vitest'
import {
  DeviceProbeMemory,
  HINT_PROBE_MAX_AGE_MS,
  PROBE_MEMORY_TTL_MS,
  PROBE_EVIDENCE_TTL_MS,
  isProbeFresh,
  newerProbe,
  probeFromHints,
  probeFromReport,
} from '../probe-evidence.js'
import { wireLadderCause, type LadderDecision } from '../adaptive-controller.js'

describe('the viewer probe as capacity evidence', () => {
  it('an offer carrying downlinkMbps is a probe, stamped as old as the client cache allows (m6)', () => {
    // The client resends a CACHED probe (≤ 30 s old) on a re-offer; stamping it
    // fresh stretched the effective TTL to 150 s.
    expect(probeFromHints(40, 100_000)).toEqual({
      kbps: 40_000,
      at: 100_000 - HINT_PROBE_MAX_AGE_MS,
    })
    expect(probeFromHints(undefined, 1_000)).toBeNull()
    expect(probeFromHints(0, 1_000)).toBeNull()
    expect(probeFromHints(Number.NaN, 1_000)).toBeNull()
  })

  it('a probe reported in the telemetry is dated by its own age plus the report age (I4)', () => {
    expect(
      probeFromReport({ downlinkMbps: 1.2, downlinkAgeMs: 4_000, reportAgeMs: 1_000 }, 60_000),
    ).toEqual({
      kbps: 1_200,
      at: 55_000,
    })
    expect(
      probeFromReport({ downlinkMbps: undefined, downlinkAgeMs: 0, reportAgeMs: 0 }, 1),
    ).toBeNull()
  })

  it('the newer probe wins, whatever it reads', () => {
    const old = { kbps: 40_000, at: 1_000 }
    const low = { kbps: 1_200, at: 2_000 }
    expect(newerProbe(old, low)).toBe(low)
    expect(newerProbe(low, old)).toBe(low)
    expect(newerProbe(null, old)).toBe(old)
    expect(newerProbe(old, null)).toBe(old)
  })

  it('fresh only within the TTL', () => {
    expect(isProbeFresh({ kbps: 1, at: 0 }, PROBE_EVIDENCE_TTL_MS)).toBe(true)
    expect(isProbeFresh({ kbps: 1, at: 0 }, PROBE_EVIDENCE_TTL_MS + 1)).toBe(false)
    expect(isProbeFresh(null, 0)).toBe(false)
  })
})

describe('wireLadderCause — the wire enum predates the try-climb', () => {
  const decision = (cause: LadderDecision['cause'], stalledForMs: number): LadderDecision => ({
    cause,
    lossRatio: 0,
    trial: false,
    stall: {
      clientKbps: null,
      sentKbps: null,
      deliveryRatio: 0.6,
      deliveryWindowMs: 4_000,
      stalledForMs,
      serverSending: true,
    },
  })
  it('a trial revert is reported as the undelivered bytes it was, and names itself in causeDetail', () => {
    expect(wireLadderCause(decision('trial-revert', 6_000), 6_000)).toEqual({
      cause: 'stall',
      causeDetail: 'trial-revert',
    })
    expect(wireLadderCause(decision('trial-revert', 0), 6_000)).toEqual({
      cause: 'loss',
      causeDetail: 'trial-revert',
    })
    expect(wireLadderCause(decision('healthy', 0), 6_000)).toEqual({ cause: 'healthy' })
  })
})

describe('DeviceProbeMemory — a stored probe does not pin a camera forever (N1)', () => {
  it('keeps the newest probe, forgets it past its TTL, and on demand', () => {
    const m = new DeviceProbeMemory(PROBE_MEMORY_TTL_MS)
    m.record(104, { kbps: 1_200, at: 0 })
    m.record(104, { kbps: 40_000, at: -5_000 }) // older: ignored
    expect(m.get(104, 1_000)).toEqual({ kbps: 1_200, at: 0 })
    expect(m.get(104, PROBE_MEMORY_TTL_MS)).not.toBeNull()
    expect(m.get(104, PROBE_MEMORY_TTL_MS + 1)).toBeNull()
    m.record(104, { kbps: 1_200, at: 10 })
    m.forget(104)
    expect(m.get(104, 11)).toBeNull()
  })
  it('the TTL is 10 minutes', () => {
    expect(PROBE_MEMORY_TTL_MS).toBe(600_000)
  })
})
