import { describe, expect, it } from 'vitest'
import {
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '../defaults.js'
import { proposeRunningThreshold } from '../propose-threshold.js'
import { RunningThresholdProposalSchema } from '../proposal-schema.js'
import * as fx from './__fixtures__/power-series.js'

function proposalOf(series: Parameters<typeof proposeRunningThreshold>[0]) {
  const answer = proposeRunningThreshold(series)
  expect(RunningThresholdProposalSchema.safeParse(answer).success).toBe(true)
  if (answer.state !== 'proposal') throw new Error(`expected a proposal, got ${answer.reason}`)
  return answer
}

describe('proposeRunningThreshold', () => {
  it('washer: a threshold above standby, a stop dwell that spans the soak pauses', () => {
    const p = proposalOf(fx.washer())
    expect(p.evidence.runsFound).toBe(6)
    expect(p.evidence.pausesFound).toBe(12)
    expect(p.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 20,
      startDwellMs: 10_000,
      stopDwellMs: 720_000,
    })
    expect(p.transform.threshold).toBeGreaterThan(p.evidence.noiseCeilingW + 2)
    expect(p.transform.threshold).toBeLessThanOrEqual(p.evidence.plateauW)
    expect(p.transform.stopDwellMs).toBeGreaterThanOrEqual(1.5 * p.evidence.longestPauseMs)
    expect(p.evidence.replay).toEqual({ intervals: 6, extra: 0, missed: 0 })
    expect(p.confidence).toBe('high')
  })

  it('washer: the catalog defaults would have split the cycle at its pauses', () => {
    const series = fx.washer()
    const p = proposalOf(series)
    // 5 W / 30 s / 180 s: the longest pause (8 min) outlasts a 3 min stop dwell.
    expect(p.evidence.longestPauseMs).toBeGreaterThan(RUNNING_POWER_STOP_DELAY_MS)
    expect(p.transform.stopDwellMs).toBeGreaterThan(RUNNING_POWER_STOP_DELAY_MS)
    expect(RUNNING_POWER_START_DELAY_MS).toBeGreaterThan(p.transform.startDwellMs)
  })

  it('dryer: one run a day, taper inside the run', () => {
    const p = proposalOf(fx.dryer())
    expect(p.evidence.runsFound).toBe(3)
    expect(p.evidence.pausesFound).toBe(0)
    expect(p.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 30,
      startDwellMs: 10_000,
      stopDwellMs: 60_000,
    })
    expect(p.evidence.replay).toEqual({ intervals: 3, extra: 0, missed: 0 })
    expect(p.confidence).toBe('medium')
  })

  it('heater: thermostat off-periods are pauses, sessions are runs', () => {
    const p = proposalOf(fx.heater())
    expect(p.evidence.runsFound).toBe(6)
    expect(p.evidence.longestPauseMs).toBeGreaterThanOrEqual(14 * 60_000)
    expect(p.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 30,
      startDwellMs: 10_000,
      stopDwellMs: 1_200_000,
    })
    expect(p.evidence.replay).toEqual({ intervals: 6, extra: 0, missed: 0 })
  })

  it('noisy standby: the threshold clears the noise ceiling', () => {
    const p = proposalOf(fx.noisyStandby())
    expect(p.evidence.noiseCeilingW).toBeGreaterThan(5)
    expect(p.transform.threshold).toBe(30)
    expect(p.evidence.replay).toEqual({ intervals: 4, extra: 0, missed: 0 })
  })

  it.each([
    ['span-too-short', fx.tooShort()],
    ['no-runs', fx.flat()],
    ['no-idle-floor', fx.noFloor()],
  ] as const)('says %s, with the catalog defaults as the fallback', (reason, series) => {
    const answer = proposeRunningThreshold(series)
    expect(answer.state).toBe('insufficient')
    if (answer.state !== 'insufficient') return
    expect(answer.reason).toBe(reason)
    expect(answer.fallback).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: RUNNING_POWER_THRESHOLD_WATTS,
      startDwellMs: RUNNING_POWER_START_DELAY_MS,
      stopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
    })
  })

  it('says no-history for an empty series and truncated for a capped read', () => {
    const empty = { ...fx.flat(), points: [] }
    expect(proposeRunningThreshold(empty)).toMatchObject({
      state: 'insufficient',
      reason: 'no-history',
    })
    const capped = { ...fx.washer(), truncated: true }
    expect(proposeRunningThreshold(capped)).toMatchObject({
      state: 'insufficient',
      reason: 'truncated',
    })
  })

  it('a 5m series is medium at best', () => {
    const p = proposalOf({ ...fx.washer(), tier: '5m' })
    expect(p.confidence).toBe('medium')
  })

  it('a null reading is skipped, never read as zero', () => {
    const series = fx.washer()
    const holes = {
      ...series,
      points: series.points.map((pt, i) => (i % 97 === 0 ? { t: pt.t, value: null } : pt)),
    }
    expect(proposalOf(holes).transform.threshold).toBeGreaterThan(5)
  })

  it('walks the stop dwell up when the replay splits a run the pauses did not predict', () => {
    const p = proposalOf(fx.washerWithLulls())
    expect(p.evidence.pausesFound).toBe(0)
    expect(p.transform.stopDwellMs).toBeGreaterThan(5 * 60_000)
    expect(p.evidence.replay).toEqual({ intervals: 5, extra: 0, missed: 0 })
  })

  it('is low and says why when the gaps cannot be told apart', () => {
    const p = proposalOf(fx.ambiguousGaps())
    expect(p.confidence).toBe('low')
    expect(p.notes.length).toBeGreaterThan(0)
  })
})
