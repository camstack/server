import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { buildHomeConnectCandidates } from '../home-connect-discovery.js'
import { HomeConnectConnectionResolver } from '../home-connect-gateway.js'
import { HomeConnectIntegrationManager } from '../home-connect-integration-manager.js'
import type { HomeConnectApplianceInfo } from '../home-connect-ws-client.js'
import { makeFakeClient } from './fake-client.js'

function noopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const DW: HomeConnectApplianceInfo = {
  haId: 'HAI-DW-1',
  name: 'Kitchen DW',
  type: 'Dishwasher',
  availablePrograms: ['Eco50'],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HomeConnectIntegrationManager.start', () => {
  it('keeps appliance inventory on surface when connect fails but pairing seeded appliances', async () => {
    const appliances: HomeConnectApplianceInfo[] = [DW]
    const resolver = new HomeConnectConnectionResolver()
    const manager = new HomeConnectIntegrationManager({
      id: 'int_0003',
      name: 'Home Connect',
      connection: { token: 'access', refresh: 'refresh-1' },
      logger: noopLogger(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      surfaceSink: resolver,
      makeClient: () =>
        makeFakeClient({
          appliances,
          connect: () => Promise.reject(new Error('WebSocket unreachable')),
        }),
    })

    await manager.start()

    expect(resolver.appliances('int_0003')).toEqual(appliances)
    expect(resolver.has('int_0003')).toBe(true)
    expect(manager.getInfo().status).toBe('error')
    expect(manager.getInfo().error).toMatch(/unreachable/i)

    const [candidate] = buildHomeConnectCandidates({
      appliances: resolver.appliances('int_0003'),
      adopted: new Map(),
    })
    expect(candidate?.childNativeId).toBe('HAI-DW-1')
  })

  it('clears surface and rethrows when connect fails with no appliances', async () => {
    const resolver = new HomeConnectConnectionResolver()
    const onDisconnected = vi.fn()
    const manager = new HomeConnectIntegrationManager({
      id: 'int_empty',
      name: 'Home Connect',
      connection: { token: 'access', refresh: 'refresh-1' },
      logger: noopLogger(),
      onConnected: vi.fn(),
      onDisconnected,
      surfaceSink: resolver,
      makeClient: () =>
        makeFakeClient({
          appliances: [],
          connect: () => Promise.reject(new Error('WebSocket unreachable')),
        }),
    })

    await expect(manager.start()).rejects.toThrow(/unreachable/i)
    expect(resolver.has('int_empty')).toBe(false)
    expect(onDisconnected).toHaveBeenCalledOnce()
  })
})

describe('HomeConnectIntegrationManager link lifecycle', () => {
  it('follows the client: a drop flips the integration off, the reconnect flips it back on', async () => {
    const resolver = new HomeConnectConnectionResolver()
    const onConnected = vi.fn()
    const onDisconnected = vi.fn()
    const client = makeFakeClient({ appliances: [DW] })
    const manager = new HomeConnectIntegrationManager({
      id: 'int_link',
      name: 'Home Connect',
      connection: { token: 'access', refresh: 'refresh-1' },
      logger: noopLogger(),
      onConnected,
      onDisconnected,
      surfaceSink: resolver,
      makeClient: () => client,
    })
    await manager.start()
    expect(manager.getInfo().status).toBe('connected')
    expect(onConnected).toHaveBeenCalledTimes(1)

    client.emitLink('HAI-DW-1', 'disconnected')
    expect(manager.getInfo().status).toBe('disconnected')
    expect(onDisconnected).toHaveBeenCalledTimes(1)

    client.emitLink('HAI-DW-1', 'connected')
    expect(manager.getInfo().status).toBe('connected')
    expect(onConnected).toHaveBeenCalledTimes(2)
  })
})
