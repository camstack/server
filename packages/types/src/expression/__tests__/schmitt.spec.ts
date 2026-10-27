import { describe, expect, it } from 'vitest'
import {
  createStatefulExpressionMemory,
  evaluateExpressionSource,
  evaluateStatefulExpressionCall,
  type StatefulExpressionMemory,
} from '../expression-source.js'

function run(
  expr: string,
  x: number | null,
  nowMs: number,
  memory: StatefulExpressionMemory,
  currentOutput: boolean | null = null,
) {
  const deadlines: number[] = []
  const result = evaluateExpressionSource(expr, { x }, nowMs, {
    invokeStateful: (invocation) =>
      evaluateStatefulExpressionCall(
        invocation,
        memory,
        { currentOutput, startedAtMs: 0, nowMs },
        { noteDeadline: (at) => deadlines.push(at) },
      ),
  })
  return { result, deadlines }
}

const BAND = 'schmitt(x, 25, 20)'

describe('schmitt builtin', () => {
  it('turns on at the high edge and off at the low edge', () => {
    const memory = createStatefulExpressionMemory()
    expect(run(BAND, 26, 0, memory).result).toEqual({ ok: true, value: true })
    expect(run(BAND, 19, 1, memory).result).toEqual({ ok: true, value: false })
  })

  it('holds its last answer inside the band', () => {
    const memory = createStatefulExpressionMemory()
    run(BAND, 26, 0, memory)
    expect(run(BAND, 22, 1, memory).result).toEqual({ ok: true, value: true })
    run(BAND, 19, 2, memory)
    expect(run(BAND, 22, 3, memory).result).toEqual({ ok: true, value: false })
  })

  it('is unknown, not off, when the first reading is inside the band', () => {
    const memory = createStatefulExpressionMemory()
    expect(run(BAND, 22, 0, memory).result).toEqual({ ok: true, value: null })
  })

  it('seeds from the restored output when memory is empty', () => {
    const memory = createStatefulExpressionMemory()
    expect(run(BAND, 22, 0, memory, true).result).toEqual({
      ok: true,
      value: true,
    })
    const other = createStatefulExpressionMemory()
    expect(run(BAND, 22, 0, other, false).result).toEqual({
      ok: true,
      value: false,
    })
  })

  it('refuses a low edge above the high edge', () => {
    const memory = createStatefulExpressionMemory()
    const { result } = run('schmitt(x, 20, 25)', 22, 0, memory)
    expect(result.ok).toBe(false)
  })

  it('a null reading fails the field and keeps the latch', () => {
    const memory = createStatefulExpressionMemory()
    run(BAND, 26, 0, memory)
    expect(run(BAND, null, 1, memory).result.ok).toBe(false)
    expect(run(BAND, 22, 2, memory).result).toEqual({ ok: true, value: true })
  })

  it('delays a transition and notes the deadline', () => {
    const memory = createStatefulExpressionMemory()
    const expr = 'schmitt(x, 25, 20, 1000, 5000)'
    run(expr, 19, 0, memory)
    const first = run(expr, 26, 10, memory)
    expect(first.result).toEqual({ ok: true, value: false })
    expect(first.deadlines).toEqual([1010])
    expect(run(expr, 26, 1010, memory).result).toEqual({
      ok: true,
      value: true,
    })
  })

  it('drops a pending transition when the reading returns to the held side', () => {
    const memory = createStatefulExpressionMemory()
    const expr = 'schmitt(x, 25, 20, 1000, 5000)'
    run(expr, 19, 0, memory)
    run(expr, 26, 10, memory)
    run(expr, 22, 500, memory)
    run(expr, 26, 600, memory)
    expect(run(expr, 26, 1500, memory).result).toEqual({
      ok: true,
      value: false,
    })
    expect(run(expr, 26, 1600, memory).result).toEqual({
      ok: true,
      value: true,
    })
  })
})
