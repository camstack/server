import { describe, expect, it } from 'vitest'
import { assertDeviceOffers, vocabCall } from '../../device/cap-vocabulary/action-index.js'
import { AutomationCommandStepSchema } from '../recipe.js'

/**
 * planning#582: a recipe restarts an Unraid VM and power-cycles a UniFi PoE port with
 * ordinary `command` steps. No step names a cap method; the vocabulary turns the action id
 * into the cap and method the provider serves.
 */
describe('recovery actions a recipe command step can name', () => {
  it('an Unraid VM restart is `workload.restart`, served by the VM device as the workload cap', () => {
    const step = AutomationCommandStepSchema.parse({
      kind: 'command',
      target: { kind: 'devices', ids: [50] },
      actionId: 'workload.restart',
    })
    expect(vocabCall(step.actionId, step.args)).toEqual({
      cap: 'workload',
      method: 'restart',
      args: {},
    })
    expect(() => assertDeviceOffers(step.actionId, 50, ['workload', 'switch'])).not.toThrow()
  })

  it('a UniFi PoE port is cycled with `switch.off` then `switch.on` on the port device', () => {
    for (const [actionId, on] of [
      ['switch.off', false],
      ['switch.on', true],
    ] as const) {
      const step = AutomationCommandStepSchema.parse({
        kind: 'command',
        target: { kind: 'devices', ids: [70] },
        actionId,
      })
      expect(vocabCall(step.actionId, step.args)).toEqual({
        cap: 'switch',
        method: 'setState',
        args: { on },
      })
      expect(() => assertDeviceOffers(actionId, 70, ['switch', 'power-meter'])).not.toThrow()
    }
  })

  it('a device a port powers is cycled with `powerSource.forceRestart`', () => {
    const step = AutomationCommandStepSchema.parse({
      kind: 'command',
      target: { kind: 'devices', ids: [80] },
      actionId: 'powerSource.forceRestart',
    })
    expect(vocabCall(step.actionId, step.args)).toMatchObject({
      cap: 'power-source',
      method: 'forceRestart',
    })
  })
})
