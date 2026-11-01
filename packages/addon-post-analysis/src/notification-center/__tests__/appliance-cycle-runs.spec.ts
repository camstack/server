import type { DeviceRun } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applianceCycleFactsFromRuns,
  CYCLE_FACTS_POLL_MS,
  CYCLE_FACTS_WAIT_MS,
} from '../appliance-cycle-runs.js'

const FINISHED_AT = Date.UTC(2026, 9, 14, 11, 0, 0)
const MIN = 60_000

function run(over: Partial<DeviceRun> & { energyKwh?: number | null }): DeviceRun {
  const { energyKwh = 0.84, ...rest } = over
  return {
    runId: `9:${FINISHED_AT - 52 * MIN}`,
    deviceId: 9,
    kind: 'appliance',
    state: 'closed',
    startedAt: FINISHED_AT - 52 * MIN,
    endedAt: FINISHED_AT,
    durationMs: 52 * MIN,
    outcome: 'completed',
    startSource: 'running-state',
    endSource: 'running-state',
    runningSource: 'native',
    phases: [],
    detail: {
      kind: 'appliance',
      energyKwh,
      energyMethod: energyKwh === null ? null : 'counter-delta',
      peakW: null,
      avgW: null,
      program: null,
      remainingAtStartSec: null,
      finalPhase: null,
      energyStartKwh: null,
      powerObservedMs: 0,
    },
    ...rest,
  }
}

function ports(answers: (DeviceRun | null)[]) {
  const slept: number[] = []
  let reads = 0
  return {
    slept,
    reads: () => reads,
    ports: {
      newestRun: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)] ?? null
        reads += 1
        return answer
      },
      sleep: async (ms: number) => {
        slept.push(ms)
      },
    },
  }
}

describe('applianceCycleFactsFromRuns', () => {
  it('reads the duration and the ENERGY from the closed run', async () => {
    const p = ports([run({})])
    expect(
      await applianceCycleFactsFromRuns(p.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: 52 * MIN, energyKwh: 0.84 })
  })

  it('keeps an unmeasured energy null, never 0', async () => {
    const p = ports([run({ energyKwh: null })])
    expect(
      await applianceCycleFactsFromRuns(p.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: 52 * MIN, energyKwh: null })
  })

  it('waits for a run that closes a moment after the flip', async () => {
    const open = run({ state: 'open', endedAt: null, durationMs: null, outcome: null })
    const p = ports([open, open, run({})])
    expect(
      await applianceCycleFactsFromRuns(p.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: 52 * MIN, energyKwh: 0.84 })
    expect(p.slept).toEqual([CYCLE_FACTS_POLL_MS, CYCLE_FACTS_POLL_MS])
  })

  it('after the bounded wait, a still-open run gives the duration from its start and no energy', async () => {
    const open = run({ state: 'open', endedAt: null, durationMs: null, outcome: null })
    const p = ports([open])
    expect(
      await applianceCycleFactsFromRuns(p.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: 52 * MIN, energyKwh: null })
    expect(p.slept.reduce((a, b) => a + b, 0)).toBe(CYCLE_FACTS_WAIT_MS)
  })

  it('knows nothing when the device has no run, or the newest run ended at another time', async () => {
    const none = ports([null])
    expect(
      await applianceCycleFactsFromRuns(none.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: null, energyKwh: null })
    const stale = ports([run({ endedAt: FINISHED_AT - 3 * 60 * MIN })])
    expect(
      await applianceCycleFactsFromRuns(stale.ports)({ deviceId: 9, finishedAtMs: FINISHED_AT }),
    ).toEqual({ durationMs: null, energyKwh: null })
  })

  it('lets a failed read reject, for the dispatcher to read as unknown', async () => {
    const resolve = applianceCycleFactsFromRuns({
      newestRun: async () => {
        throw new Error('device-runs is starting')
      },
      sleep: async () => undefined,
    })
    await expect(resolve({ deviceId: 9, finishedAtMs: FINISHED_AT })).rejects.toThrow(/starting/)
  })
})
