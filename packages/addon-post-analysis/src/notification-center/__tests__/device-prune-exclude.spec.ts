/**
 * D641 × D633: a DELETED device leaves `conditions.devicesExclude` too.
 *
 * The prune's standing rule is NEVER WIDEN — the last id of an INCLUDE list is
 * kept and the rule disabled, because removing it would make a scoped rule an
 * all-cameras rule. An EXCLUDE list is the other direction: dropping an id
 * widens it by a device that can no longer fire, which changes nothing the
 * rule can match. So every dead id is removed, the last one included — and an
 * emptied list is DELETED (the schema refuses `[]`), never written empty, and
 * never disables the rule.
 */
import { describe, expect, it } from 'vitest'
import { planDevicePrune, referencedDeviceIds } from '../device-prune.js'
import { NOTHING_RECORDED, rule, snapshot } from './device-prune-fixtures.js'

const DEAD = 102
const LIVE = 101

describe('planDevicePrune — devicesExclude', () => {
  it('removes a deleted id and keeps the others', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devicesExclude: [LIVE, DEAD] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch.conditions?.devicesExclude).toEqual([LIVE])
    expect(plan.rules[0]?.patch.enabled).toBeUndefined()
    expect(plan.rules[0]?.notes).toEqual([
      expect.objectContaining({
        field: 'conditions.devicesExclude',
        outcome: 'removed',
        subject: '102',
      }),
    ])
  })

  it('the LAST excluded id goes too: the key is deleted, the rule stays on', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [rule('r1', { conditions: { classes: ['person'], devicesExclude: [DEAD] } })],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    const conditions = plan.rules[0]?.patch.conditions
    expect(conditions).toEqual({ classes: ['person'] })
    expect(conditions).not.toHaveProperty('devicesExclude')
    expect(plan.rules[0]?.patch.enabled).toBeUndefined()
    expect(plan.rules[0]?.notes[0]).toMatchObject({
      field: 'conditions.devicesExclude',
      outcome: 'removed',
    })
  })

  it('an include AND an exclude (legacy): each list follows its own rule', () => {
    const plan = planDevicePrune(
      snapshot({
        rules: [rule('r1', { conditions: { devices: [LIVE, DEAD], devicesExclude: [DEAD] } })],
      }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules[0]?.patch.conditions).toEqual({ devices: [LIVE] })
  })

  it('an untouched exclusion plans nothing', () => {
    const plan = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devicesExclude: [LIVE] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(plan.rules).toEqual([])
  })

  it('the reconcile looks for excluded ids too', () => {
    const ids = referencedDeviceIds(
      snapshot({ rules: [rule('r1', { conditions: { devicesExclude: [DEAD] } })] }),
    )
    expect(ids.has(DEAD)).toBe(true)
  })

  it('the reconcile looks for inline `do` cap steps, on and off, without throwing', () => {
    // Bindings are `sequence` refs or inline `do` steps — never a sequence
    // body with `actions` (iterating one threw on every reconcile).
    const ids = referencedDeviceIds(
      snapshot({
        rules: [
          rule('r1', {
            actions: {
              onTrigger: [
                { kind: 'sequence', sequenceId: 'shared' },
                {
                  kind: 'do',
                  action: { kind: 'cap', deviceId: DEAD, cap: 'switch', method: 'on' },
                },
              ],
              onTriggerOff: [
                {
                  kind: 'do',
                  action: { kind: 'cap', deviceId: LIVE, cap: 'switch', method: 'off' },
                },
                { kind: 'do', action: { kind: 'wait', seconds: 1 } },
              ],
            },
          }),
        ],
      }),
    )
    expect(ids.has(DEAD)).toBe(true)
    expect(ids.has(LIVE)).toBe(true)
  })

  it('is idempotent: planning against the applied plan plans nothing', () => {
    const first = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: { devicesExclude: [DEAD] } })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    const applied = first.rules[0]?.patch.conditions ?? {}
    const second = planDevicePrune(
      snapshot({ rules: [rule('r1', { conditions: applied })] }),
      new Set([DEAD]),
      NOTHING_RECORDED,
    )
    expect(second.rules).toEqual([])
  })
})
