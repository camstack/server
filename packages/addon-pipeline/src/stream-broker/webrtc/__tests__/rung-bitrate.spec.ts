import { describe, it, expect } from 'vitest'
import { expectedRungKbps } from '../rung-bitrate.js'

describe('expectedRungKbps — what the capacity gate compares REMB against', () => {
  it('a streaming rung: the larger of its 2 s rate and its lifetime average (an IDR-less window must not understate it)', () => {
    expect(
      expectedRungKbps({
        status: 'streaming',
        bitrateKbps: 41,
        totalBytes: 12_500 * 60,
        uptimeMs: 60_000,
      }),
    ).toBe(100)
    expect(
      expectedRungKbps({
        status: 'streaming',
        bitrateKbps: 4_631,
        totalBytes: 500_000 * 60,
        uptimeMs: 60_000,
      }),
    ).toBe(4_631)
  })

  it('an idle rung that streamed before: its lifetime average', () => {
    expect(
      expectedRungKbps({
        status: 'idle',
        bitrateKbps: 0,
        totalBytes: 225_000 * 20,
        uptimeMs: 20_000,
      }),
    ).toBe(1_800)
  })

  it('a rung that has measured nothing is UNKNOWN (null), never 0 — it must not make every REMB look sufficient', () => {
    expect(
      expectedRungKbps({ status: 'idle', bitrateKbps: 0, totalBytes: 0, uptimeMs: 60_000 }),
    ).toBeNull()
    expect(
      expectedRungKbps({ status: 'streaming', bitrateKbps: 0, totalBytes: 10, uptimeMs: 500 }),
    ).toBeNull()
  })
})
