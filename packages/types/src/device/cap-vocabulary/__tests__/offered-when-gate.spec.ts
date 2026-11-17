/**
 * An action whose `offeredWhen` read ANSWERED `false` is withdrawn (D1058): a
 * switch that only reports (`getOptions().supportsSetState: false`, a PoE port
 * seen only through an API key) offers no on / off / toggle. A provider without
 * the method, a read that failed or is pending keeps them offered (D315).
 */
import { describe, expect, it } from 'vitest'
import { switchRefusesSetState } from '../../../capabilities/switch.cap.js'
import { DeviceType } from '../../device-type.js'
import {
  type ActionGateAnswer,
  actionGateAnswerFrom,
  actionsForDevice,
  offeredActionsWith,
} from '../resolve.js'
import type { LooseVocabActionGate } from '../types.js'

const switchActions = actionsForDevice(['switch'], DeviceType.Switch)
const NO_DYNAMIC = () => ({ kind: 'pending' as const })
const idsWith = (gate: ActionGateAnswer): readonly string[] =>
  offeredActionsWith(switchActions, NO_DYNAMIC, () => gate).map((a) => a.id)

describe('offeredWhen — an action gate the device answered', () => {
  it('every switch action is gated on getOptions().supportsSetState', () => {
    expect(switchActions.map((a) => [a.id, a.offeredWhen])).toEqual([
      ['switch.on', { method: 'getOptions', field: 'supportsSetState' }],
      ['switch.off', { method: 'getOptions', field: 'supportsSetState' }],
      ['switch.toggle', { method: 'getOptions', field: 'supportsSetState' }],
    ])
  })

  it('a switch that ANSWERED supportsSetState: false offers no on, off or toggle', () => {
    expect(idsWith({ kind: 'answered', open: false })).toEqual([])
  })

  it('a settable switch, a failed read and a pending read keep all three', () => {
    const all = ['switch.on', 'switch.off', 'switch.toggle']
    expect(idsWith({ kind: 'answered', open: true })).toEqual(all)
    expect(idsWith({ kind: 'failed' })).toEqual(all)
    expect(idsWith({ kind: 'pending' })).toEqual(all)
    // No gate answers at all (a caller that reads none): offered.
    expect(offeredActionsWith(switchActions, NO_DYNAMIC).map((a) => a.id)).toEqual(all)
  })

  it('asks the read the gate names, on the action cap', () => {
    const asked: string[] = []
    offeredActionsWith(switchActions, NO_DYNAMIC, (cap: string, gate: LooseVocabActionGate) => {
      asked.push(`${cap}.${gate.method}.${gate.field}`)
      return { kind: 'pending' }
    })
    expect(new Set(asked)).toEqual(new Set(['switch.getOptions.supportsSetState']))
  })
})

describe('actionGateAnswerFrom / switchRefusesSetState — what the read returned', () => {
  const gate = { method: 'getOptions', field: 'supportsSetState' }

  it('closed only on an object whose field is false', () => {
    const answer = { supportsSetState: false, supportsPowerCycle: true }
    expect(actionGateAnswerFrom(answer, gate)).toEqual({ kind: 'answered', open: false })
    expect(switchRefusesSetState(answer)).toBe(true)
  })

  it('an object with the field true or absent is open', () => {
    expect(actionGateAnswerFrom({ supportsSetState: true }, gate)).toEqual({
      kind: 'answered',
      open: true,
    })
    expect(actionGateAnswerFrom({}, gate)).toEqual({ kind: 'answered', open: true })
    expect(switchRefusesSetState({ supportsSetState: true })).toBe(false)
  })

  it('a shape that is not an object is not an answer — unknown keeps on/off', () => {
    expect(actionGateAnswerFrom(undefined, gate)).toEqual({ kind: 'failed' })
    expect(actionGateAnswerFrom([false], gate)).toEqual({ kind: 'failed' })
    expect(switchRefusesSetState(undefined)).toBe(false)
    expect(switchRefusesSetState(null)).toBe(false)
  })
})
