import { describe, expect, it } from 'vitest'
import {
  createStatefulExpressionMemory,
  evaluateExpressionSource,
  evaluateStatefulExpressionCall,
} from '../expression-source.js'

const ON = 30_000
const OFF = 180_000

function dwellAt(
  nowMs: number,
  active: boolean,
  memory = createStatefulExpressionMemory(),
  currentOutput: boolean | null = null,
  timerDriven = false,
) {
  const deadlines: number[] = []
  const result = evaluateExpressionSource(`dwell(active, ${ON}, ${OFF})`, { active }, nowMs, {
    invokeStateful: (invocation) =>
      evaluateStatefulExpressionCall(
        invocation,
        memory,
        { currentOutput, startedAtMs: 0, nowMs },
        { noteDeadline: (at) => deadlines.push(at), ...(timerDriven ? { timerDriven } : {}) },
      ),
  })
  if (!result.ok) throw new Error(result.error)
  return { value: result.value, deadlines, memory }
}

describe('dwell builtin', () => {
  it('a single isolated sample never starts: the timer over the held value does not confirm', () => {
    const memory = createStatefulExpressionMemory()
    // 7.44 W standby blip, then silence; the timer fires at +30 s on the held value.
    dwellAt(0, true, memory, false)
    const fired = dwellAt(ON, true, memory, false, true)
    expect(fired.value).toBe(false)
    // the next report (1.13 W) lands later: no start, ever.
    expect(dwellAt(ON + 1_000, false, memory, false).value).toBe(false)
    expect(dwellAt(ON + 600_000, false, memory, false, true).value).toBe(false)
  })

  it('a second satisfying sample after the delay confirms, anchored at the first', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory, false)
    expect(dwellAt(ON, true, memory, false, true).value).toBe(false)
    const { value } = dwellAt(ON + 5_000, true, memory, false)
    expect(value).toBe(true)
  })

  it('with nothing restored, a single sample stays unknown instead of confirming ON', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory)
    expect(dwellAt(ON, true, memory, null, true).value).toBeNull()
    expect(dwellAt(ON + 2_000, true, memory).value).toBe(true)
  })

  it('a held value still ends a run: the OFF side is not gated on a second sample', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory)
    dwellAt(1_000, true, memory)
    dwellAt(ON, true, memory)
    dwellAt(ON + 10_000, false, memory)
    expect(dwellAt(ON + 10_000 + OFF, false, memory, true, true).value).toBe(false)
  })

  it('active for less than onForMs → null and a deadline is noted', () => {
    const { value, deadlines } = dwellAt(10_000, true)
    expect(value).toBeNull()
    expect(deadlines).toEqual([10_000 + ON])
  })

  it('after onForMs → true', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory)
    const { value } = dwellAt(ON, true, memory)
    expect(value).toBe(true)
  })

  it('inactive for less than offForMs stays true (heating pause)', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory)
    dwellAt(ON, true, memory)
    const { value } = dwellAt(ON + 10_000, false, memory)
    expect(value).toBe(true)
  })

  it('inactive for full offForMs → false', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(0, true, memory)
    dwellAt(ON, true, memory)
    dwellAt(ON + 10_000, false, memory)
    const { value } = dwellAt(ON + 10_000 + OFF, false, memory)
    expect(value).toBe(false)
  })

  it('latchedAt stamps only when the boolean changes; null clears it', () => {
    const memory = createStatefulExpressionMemory()
    const run = (nowMs: number, v: boolean | null) => {
      const result = evaluateExpressionSource('latchedAt(x)', { x: v }, nowMs, {
        invokeStateful: (invocation) =>
          evaluateStatefulExpressionCall(invocation, memory, {
            currentOutput: null,
            startedAtMs: 0,
            nowMs,
          }),
      })
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
    expect(run(100, true)).toBe(100)
    expect(run(200, true)).toBe(100)
    expect(run(300, false)).toBe(300)
    expect(run(400, null)).toBeNull()
  })

  it('disarm: short dip returning false fails the heating-pause case', () => {
    const memory = createStatefulExpressionMemory()
    dwellAt(ON, true, memory)
    const broken = evaluateExpressionSource(
      `dwell(active, ${ON}, ${OFF})`,
      { active: false },
      ON + 10_000,
      {
        invokeStateful: (invocation) => {
          if (invocation.name === 'dwell') return false
          return evaluateStatefulExpressionCall(invocation, memory, {
            currentOutput: null,
            startedAtMs: 0,
            nowMs: ON + 10_000,
          })
        },
      },
    )
    expect(broken.ok && broken.value === false).toBe(true)
  })
})

describe('dwell seeded from the restored output', () => {
  it('seeded true, input still true: true at once, not unknown', () => {
    expect(dwellAt(1_000, true, createStatefulExpressionMemory(), true).value).toBe(true)
  })

  it('seeded true, input false: holds true until the stop delay, then false', () => {
    const memory = createStatefulExpressionMemory()
    expect(dwellAt(0, false, memory, true).value).toBe(true)
    expect(dwellAt(OFF - 1, false, memory, true).value).toBe(true)
    expect(dwellAt(OFF, false, memory, true).value).toBe(false)
  })

  it('seeded false, input true: false until the start delay, then true', () => {
    const memory = createStatefulExpressionMemory()
    expect(dwellAt(0, true, memory, false).value).toBe(false)
    expect(dwellAt(ON - 1, true, memory, false).value).toBe(false)
    expect(dwellAt(ON, true, memory, false).value).toBe(true)
  })

  it('no seed: unknown until the first delay elapses', () => {
    const memory = createStatefulExpressionMemory()
    expect(dwellAt(0, false, memory, null).value).toBeNull()
    expect(dwellAt(OFF, false, memory, null).value).toBe(false)
  })
})

describe('dwell is immune to a pulse during a pending off (D1008)', () => {
  const PULSE_ON = 90_000
  const PULSE_OFF = 180_000
  const SECOND = 1_000

  function stamped(memory: ReturnType<typeof createStatefulExpressionMemory>) {
    return (nowMs: number, active: boolean) => {
      const deadlines: number[] = []
      const result = evaluateExpressionSource(
        `latchedAt(dwell(active, ${PULSE_ON}, ${PULSE_OFF}))`,
        { active },
        nowMs,
        {
          invokeStateful: (invocation) =>
            evaluateStatefulExpressionCall(
              invocation,
              memory,
              { currentOutput: true, startedAtMs: 0, nowMs },
              { noteDeadline: (at) => deadlines.push(at) },
            ),
        },
      )
      if (!result.ok) throw new Error(result.error)
      return { value: result.value, deadlines }
    }
  }

  function pureDwell(
    memory: ReturnType<typeof createStatefulExpressionMemory>,
    currentOutput: boolean = true,
  ) {
    return (nowMs: number, active: boolean) => {
      const result = evaluateExpressionSource(
        `dwell(active, ${PULSE_ON}, ${PULSE_OFF})`,
        { active },
        nowMs,
        {
          invokeStateful: (invocation) =>
            evaluateStatefulExpressionCall(invocation, memory, {
              currentOutput,
              startedAtMs: 0,
              nowMs,
            }),
        },
      )
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
  }

  it('a 60 s pulse inside a pending off does not cancel it', () => {
    const run = pureDwell(createStatefulExpressionMemory())
    expect(run(0, false)).toBe(true) // pending off starts
    expect(run(60 * SECOND, true)).toBe(true) // the pulse begins
    expect(run(120 * SECOND, false)).toBe(true) // 60 s pulse is over, off pending since 0
    expect(run(PULSE_OFF, false)).toBe(false) // the ORIGINAL deadline still fires
  })

  it('a return that holds for the run delay does cancel the pending off', () => {
    const run = pureDwell(createStatefulExpressionMemory())
    expect(run(0, false)).toBe(true)
    expect(run(30 * SECOND, true)).toBe(true)
    expect(run(30 * SECOND + PULSE_ON, true)).toBe(true) // 90 s back: cancelled
    expect(run(PULSE_OFF, false)).toBe(true) // a new pending off began at PULSE_OFF
    expect(run(PULSE_OFF + PULSE_OFF, false)).toBe(false)
  })

  it('notes the return deadline while the pulse lasts, and the pending one once it is off', () => {
    const run = stamped(createStatefulExpressionMemory())
    run(0, false)
    expect(run(60 * SECOND, true).deadlines).toEqual([60 * SECOND + PULSE_ON])
    expect(run(100 * SECOND, false).deadlines).toEqual([PULSE_OFF])
  })

  it('a pending ON is still dropped at once by a return to off (start needs unbroken activity)', () => {
    const run = pureDwell(createStatefulExpressionMemory(), false)
    expect(run(0, true)).toBe(false)
    expect(run(60 * SECOND, false)).toBe(false)
    expect(run(100 * SECOND, true)).toBe(false) // pending restarts at 100 s
    expect(run(100 * SECOND + PULSE_ON - 1, true)).toBe(false)
    expect(run(100 * SECOND + PULSE_ON, true)).toBe(true)
  })

  it('stamps the flip to off at the last real active instant, not the confirmation', () => {
    const run = stamped(createStatefulExpressionMemory())
    expect(run(100 * SECOND, true).value).toBe(100 * SECOND) // held running, stamped at first sight
    run(200 * SECOND, false) // power falls: pending off starts
    run(260 * SECOND, true) // anti-crease pulse
    run(300 * SECOND, false)
    const closed = run(200 * SECOND + PULSE_OFF, false)
    expect(closed.value).toBe(200 * SECOND)
  })

  it('stamps a flip to on at the confirmation instant', () => {
    const memory = createStatefulExpressionMemory()
    const at = (nowMs: number, active: boolean) => {
      const result = evaluateExpressionSource(
        `latchedAt(dwell(active, ${PULSE_ON}, ${PULSE_OFF}))`,
        { active },
        nowMs,
        {
          invokeStateful: (invocation) =>
            evaluateStatefulExpressionCall(invocation, memory, {
              currentOutput: false,
              startedAtMs: 0,
              nowMs,
            }),
        },
      )
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
    at(0, false)
    at(10 * SECOND, true)
    expect(at(10 * SECOND + PULSE_ON, true)).toBe(10 * SECOND + PULSE_ON)
  })
})
