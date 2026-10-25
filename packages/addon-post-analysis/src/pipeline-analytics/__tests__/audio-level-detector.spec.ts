import { describe, it, expect } from 'vitest'
import { emptyLevelState, observeLevel, type LevelConfig } from '../audio-level-detector'

const CFG: LevelConfig = {
  windowMs: 10_000,
  deviationDb: 10,
  maxWaitMs: 20_000,
  silenceFloorDbfs: -55,
}

describe('observeLevel', () => {
  it('does not emit below the silence floor', () => {
    const r = observeLevel(emptyLevelState(), { timestampMs: 1000, dbfs: -70 }, CFG)
    expect(r.emit).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('emits a peak when dbfs exceeds the rolling mean + deviation', () => {
    let st = emptyLevelState()
    // Seed a quiet baseline around -50 dBFS over several seconds.
    for (let t = 0; t < 9; t++)
      st = observeLevel(st, { timestampMs: t * 1000, dbfs: -50 }, CFG).nextState
    // A -30 dBFS frame is +20 over the ~-50 mean → above +10 deviation → peak.
    const r = observeLevel(st, { timestampMs: 9000, dbfs: -30 }, CFG)
    expect(r.emit).toBe(true)
    expect(r.reason).toBe('peak')
  })

  it('suppresses a second peak inside the cooldown window', () => {
    let st = emptyLevelState()
    for (let t = 0; t < 9; t++)
      st = observeLevel(st, { timestampMs: t * 1000, dbfs: -50 }, CFG).nextState
    st = observeLevel(st, { timestampMs: 9000, dbfs: -30 }, CFG).nextState // peak emitted
    const r = observeLevel(st, { timestampMs: 12000, dbfs: -28 }, CFG) // 3s later, still within 20s
    expect(r.emit).toBe(false)
  })

  it('emits a heartbeat when maxWait elapses with audible audio but no peak', () => {
    let st = emptyLevelState()
    const first = observeLevel(st, { timestampMs: 0, dbfs: -40 }, CFG) // audible, first sample → emit
    expect(first.emit).toBe(true)
    expect(first.reason).toBe('heartbeat')
    st = first.nextState
    // Steady -40 (no peak). Just before maxWait: no emit. At maxWait: heartbeat.
    expect(observeLevel(st, { timestampMs: 19_000, dbfs: -40 }, CFG).emit).toBe(false)
    expect(observeLevel(st, { timestampMs: 20_000, dbfs: -40 }, CFG).reason).toBe('heartbeat')
  })

  it('evicts samples older than the window from the rolling mean', () => {
    let st = emptyLevelState()
    st = observeLevel(st, { timestampMs: 0, dbfs: -20 }, CFG).nextState // loud, ages out
    for (let t = 11; t < 20; t++)
      st = observeLevel(st, { timestampMs: t * 1000, dbfs: -50 }, CFG).nextState
    // The -20 sample is >10s old; mean is ~-50, so a -38 frame (+12) is a peak.
    const r = observeLevel(st, { timestampMs: 21_000, dbfs: -38 }, CFG)
    expect(r.reason).toBe('peak')
  })
})
