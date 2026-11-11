import { describe, expect, it } from 'vitest'
import { AutomationRecipeSchema, WAIT_UNTIL_TIMEOUT_MAX_S, stepConditionsOf } from '../recipe.js'
import type { StepConditionVerdict } from '../step-condition.js'
import { waitUntil } from '../wait-until.js'

type Result = StepConditionVerdict['result']

/** A clock the wake moves: every wake advances it by what it was asked to wait, capped at `tick`. */
function harness(readings: readonly Result[], tick = 15_000) {
  let now = 0
  let reads = 0
  const waits: number[] = []
  return {
    waits,
    reads: () => reads,
    now: () => now,
    input: (timeoutMs: number, aborted: () => boolean = () => false) => ({
      timeoutMs,
      now: () => now,
      isAborted: aborted,
      read: (): Promise<StepConditionVerdict> => {
        const result = readings[Math.min(reads, readings.length - 1)] ?? 'false'
        reads += 1
        return Promise.resolve({ result, reason: `it is ${result}` })
      },
      nextWake: (ms: number): Promise<void> => {
        waits.push(ms)
        now += Math.min(ms, tick)
        return Promise.resolve()
      },
    }),
  }
}

describe('waitUntil (#500)', () => {
  it('goes on at once when the condition is already true, without waiting', async () => {
    const h = harness(['true'])
    expect(await waitUntil(h.input(60_000))).toEqual({ result: 'met', waitedMs: 0 })
    expect(h.waits).toEqual([])
  })

  it('reads again at every wake and goes on when it turns true', async () => {
    const h = harness(['false', 'false', 'true'])
    expect(await waitUntil(h.input(60_000))).toEqual({ result: 'met', waitedMs: 30_000 })
    expect(h.reads()).toBe(3)
  })

  it('times out at the deadline with what the condition last read, never asking to wait past it', async () => {
    const h = harness(['false'])
    const out = await waitUntil(h.input(40_000))
    expect(out).toEqual({ result: 'timed-out', waitedMs: 40_000, lastReason: 'it is false' })
    expect(h.waits).toEqual([40_000, 25_000, 10_000])
  })

  it('a condition that cannot be read keeps waiting: unknown is never "met" (D49)', async () => {
    const h = harness(['unknown', 'unknown', 'true'])
    expect((await waitUntil(h.input(60_000))).result).toBe('met')
    const never = harness(['unknown'])
    expect(await waitUntil(never.input(20_000))).toMatchObject({
      result: 'timed-out',
      lastReason: 'it is unknown',
    })
  })

  it('a restart ends the wait without a verdict', async () => {
    let aborted = false
    const h = harness(['false'])
    const input = h.input(60_000, () => aborted)
    const wake = input.nextWake
    const out = await waitUntil({
      ...input,
      nextWake: async (ms) => {
        await wake(ms)
        aborted = true
      },
    })
    expect(out.result).toBe('aborted')
    expect(h.reads()).toBe(1)
  })
})

describe('wait-until schema (#500)', () => {
  const leaf = {
    kind: 'device-is',
    deviceId: 3,
    cap: 'contact',
    fieldPath: 'open',
    operator: 'eq',
    value: false,
  } as const
  const step = (over: Record<string, unknown>) => ({
    when: { kind: 'manual' },
    actions: [{ kind: 'wait-until', when: leaf, timeoutS: 600, onTimeout: 'continue', ...over }],
  })

  it('takes a condition, a timeout and what to do when it runs out', () => {
    const parsed = AutomationRecipeSchema.safeParse(step({}))
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(stepConditionsOf(parsed.data.actions[0]!)).toEqual([{ path: 'when', when: leaf }])
    }
  })

  it('refuses a timeout over six hours, and a wait with no timeout, in words', () => {
    const over = AutomationRecipeSchema.safeParse(step({ timeoutS: WAIT_UNTIL_TIMEOUT_MAX_S + 1 }))
    expect(over.success).toBe(false)
    expect(JSON.stringify(over.error?.issues)).toMatch(/at most six hours \(21600 s\)/)
    expect(AutomationRecipeSchema.safeParse(step({ timeoutS: undefined })).success).toBe(false)
    expect(AutomationRecipeSchema.safeParse(step({ timeoutS: 0 })).success).toBe(false)
    expect(AutomationRecipeSchema.safeParse(step({ onTimeout: 'retry' })).success).toBe(false)
  })
})
