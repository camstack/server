/**
 * One list of trigger variables: what a trigger's decision really carries, what
 * the generated block puts in the run's bag, and what `triggerVariablesOf` names
 * (which the editor reads) are the same set.
 */
import { describe, expect, it } from 'vitest'
import { generateAutomationBlock } from '../codegen.js'
import {
  type AutomationWhen,
  DetectionTriggerFilter,
  evaluateStationaryTrigger,
  triggerVariablesOf,
} from '../index.js'

const names = (when: AutomationWhen) => triggerVariablesOf(when).map((v) => v.name)

const detection: AutomationWhen = {
  kind: 'detection',
  deviceIds: [7],
  subjects: [{ macro: 'person' }],
}
const stationary: AutomationWhen = { kind: 'stationary', deviceIds: [7], phase: 'appeared' }

describe('triggerVariablesOf', () => {
  it('detection names exactly what a detection decision carries', () => {
    if (detection.kind !== 'detection') throw new Error('fixture')
    const filter = new DetectionTriggerFilter(detection)
    const decision = filter.evaluate(
      {
        deviceId: 7,
        trackId: 't1',
        bestClassName: 'person',
        bestConfidence: 0.9,
        phase: 'start',
      },
      Date.now(),
    )
    if (decision.kind === 'ignore') throw new Error(decision.why)
    expect([...names(detection)].sort()).toEqual(Object.keys(decision.vars).sort())
  })

  it('stationary names exactly what a stationary decision carries', () => {
    if (stationary.kind !== 'stationary') throw new Error('fixture')
    const decision = evaluateStationaryTrigger(stationary, {
      deviceId: 7,
      className: 'car',
      phase: 'appeared',
      entryId: 'e1',
      zones: [],
    })
    if (decision.kind === 'ignore') throw new Error(decision.why)
    expect([...names(stationary)].sort()).toEqual(Object.keys(decision.vars).sort())
  })

  it('a tree offers the intersection; a tree with no event row or a silent one offers none', () => {
    expect(names({ kind: 'any', children: [detection, stationary] })).toEqual([
      'deviceId',
      'className',
    ])
    expect(names({ kind: 'any', children: [detection, { kind: 'manual' }] })).toEqual([])
    expect(
      names({
        kind: 'device-is',
        deviceId: 3,
        cap: 'lock',
        fieldPath: 'locked',
        operator: 'eq',
        value: true,
      }),
    ).toEqual([])
  })

  it('the generated block puts exactly those names in the run bag', () => {
    for (const when of [detection, stationary]) {
      const source = generateAutomationBlock({
        name: 'x',
        recipe: {
          when,
          actions: [{ kind: 'cap', deviceId: 616, cap: 'siren', method: 'on' }],
        },
      })
      for (const v of triggerVariablesOf(when)) {
        expect(source).toContain(`${v.name}: decision.vars.${v.name}`)
      }
      expect(source).not.toContain('...decision.vars')
    }
  })
})
