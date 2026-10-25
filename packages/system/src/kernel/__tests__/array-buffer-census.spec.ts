/**
 * The census arms ITSELF (D444). The gate decides when; the inspector census
 * answers what; the line carries the cost.
 *
 * Disarms, one per claim:
 *  - gate: delete the `heldForMs < sustainMs` check → "a one-probe spike never
 *    pays" goes red;
 *  - gate: delete the cooldown check → "bounded, not once per probe" goes red;
 *  - gate: delete the release branch → the release test goes red;
 *  - census: change `Runtime.queryObjects` to anything that does not walk the
 *    heap → the 200 MiB the real test holds are not found;
 *  - format: drop the cost clause → the format test goes red.
 */
import { describe, expect, it } from 'vitest'
import {
  ARRAY_BUFFER_CENSUS_COOLDOWN_MS,
  ARRAY_BUFFER_CENSUS_SUSTAIN_MS,
  ARRAY_BUFFER_CENSUS_THRESHOLD_MB,
  createArrayBufferCensusGate,
  createInspectorArrayBufferCensus,
  formatArrayBufferCensus,
  isArrayBufferCensusReport,
} from '../array-buffer-census.js'

const S = 1_000
const PROBE = 2 * S

describe('the census gate', () => {
  it('a one-probe spike above the threshold never pays a forced GC', () => {
    const gate = createArrayBufferCensusGate()
    expect(gate.observe(30, 0).kind).toBe('hold')
    expect(gate.observe(ARRAY_BUFFER_CENSUS_THRESHOLD_MB + 400, PROBE).kind).toBe('hold')
    expect(gate.observe(28, 2 * PROBE).kind).toBe('hold')
    // Back above later: the sustain clock starts again from zero.
    expect(gate.observe(ARRAY_BUFFER_CENSUS_THRESHOLD_MB + 1, 3 * PROBE).kind).toBe('hold')
    expect(
      gate.observe(
        ARRAY_BUFFER_CENSUS_THRESHOLD_MB + 1,
        3 * PROBE + ARRAY_BUFFER_CENSUS_SUSTAIN_MS - 1,
      ).kind,
    ).toBe('hold')
  })

  it('fires once the reading has been above the threshold for the sustain window, and says why', () => {
    const gate = createArrayBufferCensusGate()
    let at = 0
    for (; at < ARRAY_BUFFER_CENSUS_SUSTAIN_MS; at += PROBE) {
      expect(gate.observe(700, at).kind).toBe('hold')
    }
    const verdict = gate.observe(760, at)
    expect(verdict.kind).toBe('take')
    if (verdict.kind === 'take') {
      expect(verdict.reason).toContain('arrayBuffers=760MB')
      expect(verdict.reason).toContain(`>=${ARRAY_BUFFER_CENSUS_THRESHOLD_MB}MB`)
    }
  })

  it('is bounded by the cooldown while the episode continues — not once per probe, not once per process', () => {
    const gate = createArrayBufferCensusGate()
    const firstTake = ARRAY_BUFFER_CENSUS_SUSTAIN_MS
    for (let at = 0; at < firstTake; at += PROBE) gate.observe(900, at)
    expect(gate.observe(900, firstTake).kind).toBe('take')
    let takes = 0
    let at = firstTake + PROBE
    for (; at < firstTake + ARRAY_BUFFER_CENSUS_COOLDOWN_MS; at += PROBE) {
      if (gate.observe(1_500, at).kind === 'take') takes += 1
    }
    expect(takes).toBe(0)
    expect(gate.observe(2_000, firstTake + ARRAY_BUFFER_CENSUS_COOLDOWN_MS).kind).toBe('take')
  })

  it('names a release: sustained above the threshold, then most of it gone on the next probe', () => {
    const gate = createArrayBufferCensusGate()
    let at = 0
    for (; at <= ARRAY_BUFFER_CENSUS_SUSTAIN_MS; at += PROBE) gate.observe(4_968, at)
    const verdict = gate.observe(47, at)
    expect(verdict).toEqual({ kind: 'released', fromMb: 4_968, toMb: 47 })
  })

  it('a dip inside an episode, or a spike the next sweep returns, is NOT a release', () => {
    const gate = createArrayBufferCensusGate()
    // A one-probe spike: never sustained, so its disappearance is not an event.
    gate.observe(1_300, 0)
    expect(gate.observe(28, PROBE).kind).toBe('hold')
    // Inside an episode a dip smaller than half the threshold is not a release.
    let at = 2 * PROBE
    for (; at <= 2 * PROBE + ARRAY_BUFFER_CENSUS_SUSTAIN_MS; at += PROBE) gate.observe(3_000, at)
    expect(gate.observe(2_900, at).kind).toBe('hold')
  })

  it('honours injected thresholds', () => {
    const gate = createArrayBufferCensusGate({ thresholdMb: 100, sustainMs: 0, cooldownMs: 0 })
    expect(gate.observe(99, 0).kind).toBe('hold')
    expect(gate.observe(100, 1).kind).toBe('take')
    expect(gate.observe(100, 2).kind).toBe('take')
  })
})

describe('the inspector census', () => {
  it('finds what this process is actually holding, by exact size, without writing anything', async () => {
    const MiB = 1_048_576
    const held: ArrayBuffer[] = []
    for (let i = 0; i < 200; i++) held.push(new ArrayBuffer(MiB))
    const census = createInspectorArrayBufferCensus()
    const report = await census()
    expect(isArrayBufferCensusReport(report)).toBe(true)
    expect(report.bytes).toBeGreaterThanOrEqual(200 * MiB)
    const ours = report.topSizes.find((s) => s.byteLength === MiB)
    expect(ours).toBeDefined()
    expect(ours!.count).toBeGreaterThanOrEqual(200)
    expect(held).toHaveLength(200)
  })
})

describe('the census line', () => {
  const report = {
    count: 68_201,
    bytes: 4_471 * 1_048_576,
    detached: 0,
    buckets: [{ upToBytes: 65_536, count: 68_000, bytes: 4_250 * 1_048_576 }],
    topSizes: [{ byteLength: 65_536, count: 68_000, bytes: 4_250 * 1_048_576 }],
  }

  it('carries the live total, the raw trigger reading, the shape, and the cost it paid', () => {
    const line = formatArrayBufferCensus('hub-main', report, {
      rawMb: 4_954,
      tookMs: 1_120,
      reason: 'arrayBuffers=4954MB has been >=512MB for 60000ms',
    })
    expect(line).toContain('[mem] hub-main arrayBuffer census: live=4471MB in 68201 ArrayBuffers')
    expect(line).toContain('raw arrayBuffers=4954MB')
    expect(line).toContain('LIVE — something holds them')
    expect(line).toContain('65536Bx68000=4250MB')
    expect(line).toContain('took=1120ms')
    expect(line).toContain('ONE forced full GC')
    expect(line).toContain('nothing written')
    expect(line).toContain('trigger: arrayBuffers=4954MB')
  })

  it('says when the raw growth was DEAD buffers awaiting a sweep, not a retention', () => {
    const line = formatArrayBufferCensus(
      'hub-main',
      { ...report, bytes: 40 * 1_048_576 },
      { rawMb: 1_300, tookMs: 900, reason: 'r' },
    )
    expect(line).toContain('mostly DEAD buffers awaiting a sweep')
  })
})
