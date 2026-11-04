import { DeviceType } from '../../device/device-type.js'
import { describe, expect, it } from 'vitest'
import {
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '../defaults.js'
import { proposeRunningThreshold, replayDwellIntervals } from '../propose-threshold.js'
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

  it('a pause is at most 30 min: the 3-5 min gaps are pauses, the hour gaps separate runs', () => {
    // Replaces the "gaps cannot be told apart" case: the 1 h and 70 min gaps lie beyond
    // PAUSE_MAX_MS, so the cut can no longer land on them and the answer is unambiguous.
    const p = proposalOf(fx.ambiguousGaps())
    expect(p.evidence.runsFound).toBe(9)
    expect(p.evidence.pausesFound).toBe(9)
    expect(p.evidence.replay).toEqual({ intervals: 9, extra: 0, missed: 0 })
  })

  describe('heat-pump dryer with anti-crease pulses (planning#424)', () => {
    const MIN = 60_000

    it('finds the fourteen cycles, a 3 min stop and a start dwell that rejects a pulse', () => {
      const p = proposalOf(fx.heatPumpDryer())
      expect(p.evidence.runsFound).toBe(14)
      expect(p.evidence.pausesFound).toBe(1)
      expect(p.evidence.longestPauseMs).toBeLessThan(MIN)
      expect(p.evidence.pulsesFound).toBeGreaterThanOrEqual(30)
      expect(p.evidence.longestPulseMs).toBe(45_000)
      expect(p.transform.stopDwellMs).toBe(180_000)
      expect(p.transform.startDwellMs).toBeGreaterThanOrEqual(90_000)
      expect(p.transform.threshold).toBeGreaterThan(p.evidence.noiseCeilingW + 2)
      expect(p.evidence.replay).toEqual({ intervals: 14, extra: 0, missed: 0 })
      expect(p.confidence).toBe('high')
    })

    it('the OLD stored expression (5 W / 30 s / 10 min) merges four pairs: 10 intervals, not 14', () => {
      const series = fx.heatPumpDryer()
      const old = replayDwellIntervals(series, {
        threshold: 5,
        startDwellMs: 30_000,
        stopDwellMs: 600_000,
      })
      expect(old).toHaveLength(10)
      const proposal = proposalOf(series)
      expect(replayDwellIntervals(series, proposal.transform)).toHaveLength(14)
    })

    it('a washer floor keeps a soak from ending the run', () => {
      const p = proposalOf({ ...fx.washer(), deviceType: DeviceType.Washer })
      expect(p.transform.stopDwellMs).toBeGreaterThanOrEqual(10 * MIN)
    })
  })
})
