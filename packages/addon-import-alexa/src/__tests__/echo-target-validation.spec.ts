import { describe, expect, it } from 'vitest'
import { type SpeakBrokerView, validateEchoTarget } from '../speak/provider.js'

const account = (id: string, echoes: readonly string[]): SpeakBrokerView => ({
  id,
  name: id,
  ready: true,
  devices: echoes.map((echo) => ({
    id: echo,
    name: echo,
    family: 'ECHO',
    online: true,
    kind: 'device' as const,
    dnd: false,
    deviceType: 'T',
  })),
})

describe('validateEchoTarget (the save-time rule of an Echo instance)', () => {
  it('refuses a blank Echo', () => {
    expect(() => validateEchoTarget([account('a1', ['e1'])], { brokerId: 'a1' })).toThrow(
      'Pick the Echo',
    )
  })

  it('refuses a blank account that cannot be told, with no account at all', () => {
    expect(() => validateEchoTarget([], { echoId: 'e1' })).toThrow('Add an Amazon account')
  })

  it('refuses an ambiguous account: two accounts, and the Echo belongs to neither alone', () => {
    const both = [account('a1', ['e1']), account('a2', ['e1'])]
    expect(() => validateEchoTarget(both, { echoId: 'e1' })).toThrow('Pick the Amazon account')
  })

  it('refuses a named account that is gone', () => {
    expect(() =>
      validateEchoTarget([account('a1', ['e1'])], { echoId: 'e1', brokerId: 'gone' }),
    ).toThrow('gone')
  })

  it('pins the account the moment it is known (the only one, or the one holding the Echo)', () => {
    expect(validateEchoTarget([account('a1', ['e1'])], { echoId: 'e1' })).toEqual({
      brokerId: 'a1',
    })
    const two = [account('a1', ['e1']), account('a2', ['e2'])]
    expect(validateEchoTarget(two, { echoId: 'e2' })).toEqual({ brokerId: 'a2' })
  })

  it('keeps an account the operator named', () => {
    expect(validateEchoTarget([account('a1', ['e1'])], { echoId: 'e1', brokerId: 'a1' })).toEqual(
      {},
    )
  })
})
