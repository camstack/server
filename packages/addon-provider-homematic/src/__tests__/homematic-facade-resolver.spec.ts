import { beforeEach, describe, expect, it } from 'vitest'
import { Homematic } from 'nodehomematic'
import { HmFacadeResolver, type HmSessionView } from '../homematic-facade-resolver.js'

// A real facade is constructible without a network: nothing connects until start().
function makeFacade(): Homematic {
  return new Homematic({
    host: '10.0.0.1',
    interfaces: ['HmIP-RF'],
    callback: { host: '10.0.0.2', port: 2128 },
    tls: false,
  })
}

function makeSession(host: string): HmSessionView {
  return {
    getConnection: () => ({
      host,
      enableHmipRf: true,
      enableBidcosRf: false,
      enableGroups: true,
      enableBidcosWired: false,
      username: '',
      password: '',
      callbackHost: '',
      callbackPort: 2128,
      tls: false,
    }),
    getInfo: () => ({
      id: 'int-1',
      name: 'CCU',
      kind: 'homematic',
      status: 'connected',
      info: {},
      lastCheckedAt: null,
      error: null,
    }),
  }
}

describe('HmFacadeResolver', () => {
  let resolver: HmFacadeResolver
  beforeEach(() => {
    resolver = new HmFacadeResolver()
  })

  it('resolves the facade of each integration by its own id', () => {
    const a = makeFacade()
    const b = makeFacade()
    resolver.set('int-a', a)
    resolver.set('int-b', b)
    expect(resolver.get('int-a')).toBe(a)
    expect(resolver.get('int-b')).toBe(b)
  })

  it('resolves nothing for an absent id: there is no primary CCU to fall back to', () => {
    resolver.set('int-a', makeFacade())
    expect(resolver.get(undefined)).toBeNull()
    expect(resolver.get(null)).toBeNull()
    expect(resolver.get('int-unknown')).toBeNull()
  })

  it('set(id, null) removes only that integration', () => {
    const b = makeFacade()
    resolver.set('int-a', makeFacade())
    resolver.set('int-b', b)
    resolver.set('int-a', null)
    expect(resolver.get('int-a')).toBeNull()
    expect(resolver.get('int-b')).toBe(b)
  })

  it('publishes the session next to the facade and fans state changes out to subscribers', () => {
    const session = makeSession('10.0.0.1')
    resolver.setSession('int-a', session)
    expect(resolver.getSession('int-a')).toBe(session)
    expect(resolver.getSession(undefined)).toBeNull()

    let ticks = 0
    const unsub = resolver.onSnapshot('int-a', () => {
      ticks += 1
    })
    resolver.emitSnapshot('int-a')
    resolver.emitSnapshot('int-other')
    expect(ticks).toBe(1)
    unsub()
    resolver.emitSnapshot('int-a')
    expect(ticks).toBe(1)
  })

  it('one throwing subscriber does not starve the others', () => {
    let reached = false
    resolver.onSnapshot('int-a', () => {
      throw new Error('boom')
    })
    resolver.onSnapshot('int-a', () => {
      reached = true
    })
    resolver.emitSnapshot('int-a')
    expect(reached).toBe(true)
  })

  it('clear() empties facades, sessions and subscribers', () => {
    resolver.set('int-a', makeFacade())
    resolver.setSession('int-a', makeSession('h'))
    let ticks = 0
    resolver.onSnapshot('int-a', () => {
      ticks += 1
    })
    resolver.clear()
    resolver.emitSnapshot('int-a')
    expect(resolver.get('int-a')).toBeNull()
    expect(resolver.getSession('int-a')).toBeNull()
    expect(ticks).toBe(0)
  })
})
