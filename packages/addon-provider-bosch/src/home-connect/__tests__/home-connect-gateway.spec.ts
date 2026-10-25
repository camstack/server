import { describe, expect, it } from 'vitest'
import { HomeConnectConnectionResolver } from '../home-connect-gateway.js'
import { makeFakeClient } from './fake-client.js'

const DW = { haId: 'HAI-1', name: 'DW', type: 'Dishwasher', availablePrograms: [] }

describe('HomeConnectConnectionResolver.watch', () => {
  it('a watcher registered before the client exists is told when it appears', () => {
    const resolver = new HomeConnectConnectionResolver()
    const events: string[] = []
    resolver.watch('int', 'HAI-1', (e) => events.push(e.kind))

    const client = makeFakeClient({ appliances: [DW] })
    resolver.set('int', { appliances: [DW], client })
    expect(events).toEqual(['client'])

    client.emitFeature('HAI-1', 'BSH.Common.Status.OperationState', 'Run')
    client.emitLink('HAI-1', 'disconnected')
    expect(events).toEqual(['client', 'feature', 'link'])
  })

  it('follows a restart: the old client is released, the new client is heard', () => {
    const resolver = new HomeConnectConnectionResolver()
    const events: string[] = []
    const first = makeFakeClient({ appliances: [DW] })
    resolver.set('int', { appliances: [DW], client: first })
    resolver.watch('int', 'HAI-1', (e) => events.push(e.kind))

    const second = makeFakeClient({ appliances: [DW] })
    resolver.set('int', { appliances: [DW], client: second })
    expect(events).toEqual(['client'])

    first.emitFeature('HAI-1', 'k', 1)
    expect(events).toEqual(['client'])
    second.emitFeature('HAI-1', 'k', 1)
    expect(events).toEqual(['client', 'feature'])
  })

  it('tells the watcher when the client goes away', () => {
    const resolver = new HomeConnectConnectionResolver()
    const client = makeFakeClient({ appliances: [DW] })
    resolver.set('int', { appliances: [DW], client })
    const events: string[] = []
    resolver.watch('int', 'HAI-1', (e) => events.push(e.kind))
    resolver.set('int', null)
    expect(events).toEqual(['client'])
    client.emitFeature('HAI-1', 'k', 1)
    expect(events).toEqual(['client'])
  })

  it('only hears its own appliance, and nothing after unsubscribe', () => {
    const resolver = new HomeConnectConnectionResolver()
    const client = makeFakeClient({ appliances: [DW] })
    resolver.set('int', { appliances: [DW], client })
    const events: string[] = []
    const stop = resolver.watch('int', 'HAI-1', (e) => events.push(e.kind))
    client.emitFeature('OTHER', 'k', 1)
    expect(events).toEqual([])
    stop()
    client.emitFeature('HAI-1', 'k', 1)
    expect(events).toEqual([])
  })

  it('reports a description change on the appliance', () => {
    const resolver = new HomeConnectConnectionResolver()
    const client = makeFakeClient({
      appliances: [DW],
      description: {
        entities: { '1': { uid: 1, name: 'BSH.Common.Option.HalfLoad', kind: 'option' } },
      },
    })
    resolver.set('int', { appliances: [DW], client })
    const events: string[] = []
    resolver.watch('int', 'HAI-1', (e) => events.push(e.kind))
    client.description.applyChanges([{ uid: 1, available: false }])
    expect(events).toEqual(['description'])
  })
})
