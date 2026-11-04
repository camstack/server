import { describe, expect, it } from 'vitest'
import { createStatefulExpressionMemory } from '../../expression/expression-source.js'
import { expression, fromRead } from '../customize/field-source.js'
import {
  type FieldOutcome,
  type SourceReading,
  evaluateCompositionField,
} from '../evaluate-field.js'

const SECOND = 1_000
const ON_MS = 90 * SECOND
const OFF_MS = 180 * SECOND
const PLUG = { addonId: 'zigbee', stableId: 'plug' } as const
const OWN = { addonId: 'composer', stableId: 'self' } as const

/**
 * The composed dryer's two fields as the composer evaluates them: `running` is
 * `dwell(power >= 15, 90 s, 180 s)`, `since` is `latchedAt(running)` reading the
 * own field. Their outcomes travel between the two the way `ownFieldReading` does.
 */
function dryer(restored: boolean) {
  const runningMemory = createStatefulExpressionMemory()
  const sinceMemory = createStatefulExpressionMemory()
  let running: FieldOutcome | null = null
  let since: FieldOutcome | null = null
  return {
    step(nowMs: number, watts: number): { running: unknown; since: unknown } {
      running = evaluateCompositionField({
        source: expression('dwell(x >= 15, 90000, 180000)', {
          x: fromRead(PLUG, 'power-meter', 'power'),
        }),
        read: () => ({ state: 'fresh', value: watts }),
        now: nowMs,
        stateful: {
          currentOutput: running?.value ?? restored,
          expressionMemory: runningMemory,
          startedAtMs: 0,
        },
      })
      const own: SourceReading =
        running.state === 'unavailable'
          ? { state: 'unavailable', reason: 'n/a', fatal: false }
          : {
              state: 'fresh',
              value: running.value,
              ...(running.state === 'fresh' && running.transition !== undefined
                ? { transition: running.transition }
                : {}),
            }
      since = evaluateCompositionField({
        source: expression('latchedAt(running)', {
          running: fromRead(OWN, 'running-state', 'running'),
        }),
        read: () => own,
        now: nowMs,
        stateful: {
          currentOutput: since?.value ?? null,
          expressionMemory: sinceMemory,
          startedAtMs: 0,
        },
      })
      return { running: running.value, since: since.value }
    },
  }
}

describe('running-state `since` marks the last real active instant (planning#424)', () => {
  it('a flip to off is stamped where the pending off began, pulses notwithstanding', () => {
    const d = dryer(true)
    expect(d.step(0, 600)).toEqual({ running: true, since: 0 })
    const endAt = 1_000 * SECOND
    d.step(endAt, 2)
    d.step(endAt + 90 * SECOND, 320) // anti-crease pulse
    d.step(endAt + 135 * SECOND, 2)
    expect(d.step(endAt + OFF_MS, 2)).toEqual({ running: false, since: endAt })
  })

  it('a flip to on is stamped at its confirmation', () => {
    const d = dryer(false)
    d.step(0, 2)
    d.step(OFF_MS, 2)
    d.step(OFF_MS + 5 * SECOND, 600)
    expect(d.step(OFF_MS + 5 * SECOND + ON_MS, 600)).toEqual({
      running: true,
      since: OFF_MS + 5 * SECOND + ON_MS,
    })
  })
})
