/**
 * A bounded pass means MORE WORK, not "done until tomorrow".
 *
 * `HourAdoptionSweeper.sweep()` walks at most 512 hour listings and returns
 * `bounded: true` when it stopped at that cap with a cursor to resume from. The
 * recorder ran exactly one sweep per location per DAY, so an archive with tens
 * of thousands of unrepaired hours would take months — and the cursor lives in
 * RAM, so every restart sent it back to the beginning. The first real pass on
 * this hub adopted 29 037 segments from one location and came back
 * `bounded: true`: there was more, and the next look was 24 hours away.
 *
 * `runAdoptionCatchUp` keeps sweeping while there is work and while the budget
 * lasts, pacing between passes. The daily interval stays what it is — the
 * cadence for a quiet archive, not the speed limit for a damaged one.
 */
import { describe, expect, it, vi } from 'vitest'
import { runAdoptionCatchUp } from '../addon/hour-adoption-catchup.js'

interface FakeReport {
  readonly bounded: boolean
}

function sweeperReturning(sequence: readonly boolean[]) {
  let index = 0
  return vi.fn(async (): Promise<FakeReport> => {
    const bounded = sequence[Math.min(index, sequence.length - 1)] ?? false
    index += 1
    return { bounded }
  })
}

describe('runAdoptionCatchUp', () => {
  it('stops as soon as a location has nothing left to adopt', async () => {
    const sweep = sweeperReturning([false])
    const elapsed = vi.fn(() => 0)
    await runAdoptionCatchUp({
      locationIds: ['a', 'b'],
      sweep,
      budgetMs: 60_000,
      now: elapsed,
      pace: async () => undefined,
    })
    // One sweep per location, no more.
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('keeps going while the pass reports it was bounded', async () => {
    const sweep = sweeperReturning([true, true, false])
    await runAdoptionCatchUp({
      locationIds: ['a'],
      sweep,
      budgetMs: 60_000,
      now: () => 0,
      pace: async () => undefined,
    })
    expect(sweep).toHaveBeenCalledTimes(3)
  })

  it('gives up on the BUDGET, not on the work — the next pass resumes', async () => {
    const sweep = sweeperReturning([true])
    let clock = 0
    await runAdoptionCatchUp({
      locationIds: ['a'],
      sweep,
      budgetMs: 1_000,
      // Each turn of the loop costs 400 ms of budget.
      now: () => {
        clock += 400
        return clock
      },
      pace: async () => undefined,
    })
    expect(sweep.mock.calls.length).toBeGreaterThan(0)
    expect(sweep.mock.calls.length).toBeLessThan(5)
  })

  it('reports MORE WORK when it stopped on the budget, and none when it finished', async () => {
    let clock = 0
    const stoppedOnBudget = await runAdoptionCatchUp({
      locationIds: ['a'],
      sweep: sweeperReturning([true]),
      budgetMs: 1_000,
      now: () => {
        clock += 400
        return clock
      },
      pace: async () => undefined,
    })
    expect(stoppedOnBudget).toBe(true)

    const finished = await runAdoptionCatchUp({
      locationIds: ['a'],
      sweep: sweeperReturning([false]),
      budgetMs: 60_000,
      now: () => 0,
      pace: async () => undefined,
    })
    expect(finished).toBe(false)
  })

  it('a location that throws does not stop the others', async () => {
    const sweep = vi.fn(async ({ locationId }: { locationId: string }) => {
      if (locationId === 'bad') throw new Error('unreadable')
      return { bounded: false }
    })
    const seen: string[] = []
    await runAdoptionCatchUp({
      locationIds: ['bad', 'good'],
      sweep: async (input) => {
        seen.push(input.locationId)
        return sweep(input)
      },
      budgetMs: 60_000,
      now: () => 0,
      pace: async () => undefined,
      onError: () => undefined,
    })
    expect(seen).toEqual(['bad', 'good'])
  })
})
