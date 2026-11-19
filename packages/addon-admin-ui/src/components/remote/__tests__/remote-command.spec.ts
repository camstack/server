import { describe, expect, it } from 'vitest'
import { bindingOfCommand, commandOfBinding } from '../remote-command'

describe('remote command translation', () => {
  it('a command with no action chosen yet is no binding, and does not throw', () => {
    expect(
      bindingOfCommand({ kind: 'command', target: { kind: 'devices', ids: [7] }, actionId: '' }),
    ).toBeNull()
  })

  it('a binding the vocabulary does not cover opens as an empty command, and stays unbound', () => {
    const step = commandOfBinding({
      kind: 'cap',
      deviceId: 7,
      cap: 'no-such-cap',
      method: 'nothing',
    })
    expect(step.actionId).toBe('')
    expect(bindingOfCommand(step)).toBeNull()
  })

  it('a picked action becomes its cap method', () => {
    const action = bindingOfCommand({
      kind: 'command',
      target: { kind: 'devices', ids: [7] },
      actionId: 'switch.on',
    })
    expect(action).toMatchObject({ kind: 'cap', deviceId: 7, cap: 'switch' })
  })
})
