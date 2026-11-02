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
) {
  const deadlines: number[] = []
  const result = evaluateExpressionSource(`dwell(active, ${ON}, ${OFF})`, { active }, nowMs, {
    invokeStateful: (invocation) =>
      evaluateStatefulExpressionCall(
        invocation,
        memory,
        { currentOutput, startedAtMs: 0, nowMs },
        { noteDeadline: (at) => deadlines.push(at) },
      ),
  })
  if (!result.ok) throw new Error(result.error)
  return { value: result.value, deadlines, memory }
}

describe('dwell builtin', () => {
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
