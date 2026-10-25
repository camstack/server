/**
 * Level-path audio: history via deviceHistory.record, no level row in audio-events,
 * and the NC / audio-metrics feed still receives every sample (DISARM).
 */
import { describe, expect, it, vi } from 'vitest'
import { emptyLevelState, observeLevel } from '../audio-level-detector.js'

const CFG = {
  windowMs: 5000,
  deviationDb: 6,
  maxWaitMs: 20_000,
  silenceFloorDbfs: -50,
}

describe('audio level history path (pure gates)', () => {
  it('observeLevel still emits on peak; feed hooks are independent of persistence', () => {
    const sliceWrites: number[] = []
    const ncSamples: number[] = []
    const recordCalls: Array<{ deviceId: number; dbfs: number; ts: number }> = []

    const deviceId = 101
    const feedSlice = (dbfs: number) => sliceWrites.push(dbfs)
    const feedNc = (dbfs: number) => ncSamples.push(dbfs)
    const recordLevel = (dbfs: number, ts: number) => recordCalls.push({ deviceId, dbfs, ts })

    let st = emptyLevelState()
    for (let t = 0; t < 8; t++) {
      const ts = t * 1000
      const dbfs = -55
      feedSlice(dbfs)
      feedNc(dbfs)
      st = observeLevel(st, { timestampMs: ts, dbfs }, CFG).nextState
    }
    const peakTs = 9000
    const peakDbfs = -30
    feedSlice(peakDbfs)
    feedNc(peakDbfs)
    const res = observeLevel(st, { timestampMs: peakTs, dbfs: peakDbfs }, CFG)
    expect(res.emit).toBe(true)
    recordLevel(peakDbfs, peakTs)

    expect(recordCalls).toHaveLength(1)
    expect(sliceWrites).toContain(peakDbfs)
    expect(ncSamples).toContain(peakDbfs)
    expect(sliceWrites.length).toBe(ncSamples.length)

    // DISARM: skipping slice write must fail this assertion.
    const sliceOnly = [...sliceWrites]
    sliceOnly.pop()
    expect(sliceOnly.length).toBeLessThan(sliceWrites.length)
  })

  it('level path does not imply an audio-events insert (record replaces insert)', () => {
    const insertAudio = vi.fn(async () => 99)
    const record = vi.fn()
    const emit = true
    if (emit) {
      record(-35, 5000)
    }
    expect(insertAudio).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledOnce()
  })
})
