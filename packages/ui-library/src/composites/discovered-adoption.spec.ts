import { describe, expect, it } from 'vitest'
import { findAdoptedTarget, type AdoptedTarget } from './discovered-adoption'

const alexa: AdoptedTarget = {
  id: 't1',
  name: 'Kitchen Echo',
  kind: 'alexa-speak',
  values: { brokerId: 'b1', echoId: 'e1', family: 'ECHO' },
}
const candidate = {
  brokerId: 'b1',
  echoId: 'e1',
  family: 'ECHO',
  deviceKind: 'echo',
}
const keys = ['brokerId', 'echoId']

describe('findAdoptedTarget', () => {
  it('matches the same kind and the same identifying values', () => {
    expect(findAdoptedTarget('alexa-speak', candidate, keys, [alexa])).toBe(alexa)
  })

  it('ignores non-identifying keys the target does not hold', () => {
    expect(findAdoptedTarget('alexa-speak', candidate, keys, [alexa])?.id).toBe('t1')
  })

  it('does not match another device, another kind or another broker', () => {
    expect(
      findAdoptedTarget('alexa-speak', { ...candidate, echoId: 'e2' }, keys, [alexa]),
    ).toBeNull()
    expect(
      findAdoptedTarget('alexa-speak', { ...candidate, brokerId: 'b2' }, keys, [alexa]),
    ).toBeNull()
    expect(findAdoptedTarget('other', candidate, keys, [alexa])).toBeNull()
  })

  it('falls back to every non-empty scalar when the kind declares no identity keys', () => {
    const target: AdoptedTarget = {
      ...alexa,
      values: { brokerId: 'b1', echoId: 'e1' },
    }
    expect(
      findAdoptedTarget('alexa-speak', { brokerId: 'b1', echoId: 'e1' }, undefined, [target]),
    ).toBe(target)
    expect(findAdoptedTarget('alexa-speak', candidate, undefined, [target])).toBeNull()
  })

  it('never matches a candidate with nothing to compare', () => {
    expect(findAdoptedTarget('alexa-speak', { echoId: '' }, undefined, [alexa])).toBeNull()
    expect(findAdoptedTarget('alexa-speak', {}, keys, [alexa])).toBeNull()
  })

  it('marks nothing while the existing targets are unanswered', () => {
    expect(findAdoptedTarget('alexa-speak', candidate, keys, undefined)).toBeNull()
  })

  it('does not match a secret on the target side', () => {
    const secret: AdoptedTarget = {
      ...alexa,
      values: { echoId: { $secret: true } },
    }
    expect(findAdoptedTarget('alexa-speak', candidate, ['echoId'], [secret])).toBeNull()
  })
})
