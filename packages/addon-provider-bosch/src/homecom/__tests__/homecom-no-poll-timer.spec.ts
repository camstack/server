/**
 * D1062 — the HomeCom manager arms no poll timer: the gateway is read at start
 * and then only when the core asks (`poll()`), and a failed read is thrown to the caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionFromSettings, type HomeComConfig } from '../config.js'
import type { HomeComApiClient, HomeComSystemSnapshot } from '../homecom-api-client.js'
import { HomeComConnectionResolver } from '../homecom-gateway.js'
import { HomeComIntegrationManager } from '../homecom-integration-manager.js'

const SNAPSHOT: HomeComSystemSnapshot = {
  gateway: { gatewayId: 'g1', name: 'K40', model: 'K40' },
  circuits: [],
  dhw: null,
}

function conn(): HomeComConfig {
  const parsed = connectionFromSettings({ token: 't', refresh: 'r', gatewayId: 'g1' })
  if (parsed === null) throw new Error('settings did not parse')
  return parsed
}

function rig(fetchSystem: HomeComApiClient['fetchSystem']) {
  const unused = async () => {
    throw new Error('not used')
  }
  const api: HomeComApiClient = {
    refreshTokens: unused,
    listGateways: async () => [{ gatewayId: 'g1', name: 'g1' }],
    fetchSystem,
    probeGateway: unused,
    setCircuitSetpoint: unused,
    setCircuitMode: unused,
    setDhwTarget: unused,
    setDhwMode: unused,
    setFanMode: unused,
    setSwingVertical: unused,
    setSwingHorizontal: unused,
    writeHeatPump: unused,
    readResource: unused,
  }
  const resolver = new HomeComConnectionResolver()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const manager = new HomeComIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection: conn(),
    logger: logger as never,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: resolver,
    makeClient: () => api,
  })
  return { manager, resolver, logger }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HomeCom manager under the core state refresh (D1062)', () => {
  it('reads the gateway at start and never again on its own', async () => {
    vi.useFakeTimers()
    const fetchSystem = vi.fn(async () => SNAPSHOT)
    const { manager } = rig(fetchSystem)
    await manager.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetchSystem).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('the surface refresh reads once and fans the new snapshot out to the devices', async () => {
    const fetchSystem = vi.fn(async () => SNAPSHOT)
    const { manager, resolver } = rig(fetchSystem)
    await manager.start()
    const seen = vi.fn()
    resolver.onSnapshot('int-1', seen)
    await resolver.getRefresh('int-1')?.()
    expect(fetchSystem).toHaveBeenCalledTimes(2)
    expect(seen).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('a failed read is thrown to the caller and logged with the integration', async () => {
    const fetchSystem = vi
      .fn<HomeComApiClient['fetchSystem']>()
      .mockResolvedValueOnce(SNAPSHOT)
      .mockRejectedValueOnce(new Error('cloud down'))
    const { manager, logger } = rig(fetchSystem)
    await manager.start()
    await expect(manager.poll()).rejects.toThrow('cloud down')
    expect(logger.warn).toHaveBeenCalledWith(
      'HomeCom poll failed',
      expect.objectContaining({ meta: expect.objectContaining({ integrationId: 'int-1' }) }),
    )
    await manager.stop()
  })
})
