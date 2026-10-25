/**
 * Review LOW-N1: the sweep stays quiet about a processor whose window counted
 * nothing — and ONLY then. Every counter of the summary makes it non-idle.
 *
 * Disarm: drop any one term from `isIdleTrackerStats` (e.g. `lowScoreHolds`):
 * its row below fails.
 */
import { describe, expect, it } from 'vitest'
import { isIdleTrackerStats, type TrackerV2Stats } from '../pipeline/frame-processor.js'

const NO_ENDS = { missed: 0, ambiguous: 0, dropped: 0, stationary: 0, 'clock-step': 0 }
const IDLE: TrackerV2Stats = {
  tracklets: { confirmed: NO_ENDS, unconfirmed: NO_ENDS },
  splits: 0,
  linksCommitted: 0,
  linksRefused: 0,
  linksNew: 0,
  linksDisagreed: 0,
  lowScoreHolds: 0,
  outOfOrderFrames: 0,
  clockSteps: 0,
}

describe('isIdleTrackerStats', () => {
  it('an all-zero window is idle', () => {
    expect(isIdleTrackerStats(IDLE)).toBe(true)
  })

  it.each([
    'splits',
    'linksCommitted',
    'linksRefused',
    'linksNew',
    'linksDisagreed',
    'lowScoreHolds',
    'outOfOrderFrames',
    'clockSteps',
  ] as const)('%s > 0 is not idle', (field) => {
    expect(isIdleTrackerStats({ ...IDLE, [field]: 1 })).toBe(false)
  })

  it.each([
    'missed',
    'ambiguous',
    'dropped',
    'stationary',
    'clock-step',
  ] as const)('a %s end, confirmed or not, is not idle', (reason) => {
    const one = { ...NO_ENDS, [reason]: 1 }
    expect(
      isIdleTrackerStats({ ...IDLE, tracklets: { confirmed: one, unconfirmed: NO_ENDS } }),
    ).toBe(false)
    expect(
      isIdleTrackerStats({ ...IDLE, tracklets: { confirmed: NO_ENDS, unconfirmed: one } }),
    ).toBe(false)
  })
})
