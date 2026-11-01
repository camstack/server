/**
 * The editor offers exactly the variables the generated block puts in the
 * run's bag: both read `triggerVariablesOf`. The editor used to repeat the
 * names and had lost `label` (detection) and `zones` (stationary).
 */
import { type AutomationWhen, triggerVariablesOf } from '@camstack/types'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { whenScopeVariables } from '../scope-variables'

const t: TFunction = ((_key: string, fallback: string) => fallback) as TFunction

const detection: AutomationWhen = {
  kind: 'detection',
  deviceIds: [7],
  subjects: [{ macro: 'person' }],
}
const stationary: AutomationWhen = { kind: 'stationary', deviceIds: [7], phase: 'appeared' }

describe('whenScopeVariables', () => {
  it('offers exactly triggerVariablesOf, for every event kind and mixture', () => {
    for (const when of [
      detection,
      stationary,
      { kind: 'any', children: [detection, stationary] } satisfies AutomationWhen,
      { kind: 'manual' } satisfies AutomationWhen,
    ]) {
      expect(whenScopeVariables(when, t).map((v) => v.name)).toEqual(
        triggerVariablesOf(when).map((v) => v.name),
      )
    }
  })

  it('the variables the old hard-coded lists dropped are offered', () => {
    expect(whenScopeVariables(detection, t).map((v) => v.name)).toContain('label')
    expect(whenScopeVariables(stationary, t).map((v) => v.name)).toContain('zones')
  })
})
