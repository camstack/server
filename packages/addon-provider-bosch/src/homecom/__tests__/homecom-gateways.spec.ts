import { describe, expect, it, vi } from 'vitest'
import { connectionFromSettings, HOMECOM_GATEWAYS_PATH, type HomeComConfig } from '../config.js'
import type { FetchFn } from '../homecom-api-client.js'
import { parseHomeComGatewayList } from '../homecom-api-client.js'
import { HomeComConnectionResolver } from '../homecom-gateway.js'
import { HomeComIntegrationManager } from '../homecom-integration-manager.js'

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function cloud(gateways: readonly unknown[], requested: string[]): FetchFn {
  return async (url) => {
    requested.push(url)
    if (url.endsWith(HOMECOM_GATEWAYS_PATH)) {
      return { ok: true, status: 200, json: async () => gateways }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ references: [] }),
    }
  }
}

function conn(extra: Record<string, unknown> = {}): HomeComConfig {
  const parsed = connectionFromSettings({ token: 't', refresh: 'r', ...extra })
  if (parsed === null) throw new Error('settings did not parse')
  return parsed
}

function mgr(connection: HomeComConfig, fetchFn: FetchFn, chosen: string[] = []) {
  return new HomeComIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection,
    logger: logger() as never,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: new HomeComConnectionResolver(),
    fetchFn,
    onGatewayChosen: (id) => void chosen.push(id),
    pollIntervalMs: 3_600_000,
  })
}

describe('HomeCom gateway discovery', () => {
  it('reads gateway ids from the account listing', () => {
    expect(
      parseHomeComGatewayList([{ deviceId: '101' }, { gatewayId: '102', name: 'Cellar' }]),
    ).toEqual([
      { gatewayId: '101', name: '101' },
      { gatewayId: '102', name: 'Cellar' },
    ])
    expect(parseHomeComGatewayList({ gateways: [{ id: '7' }] })).toEqual([
      { gatewayId: '7', name: '7' },
    ])
    expect(parseHomeComGatewayList('nope')).toEqual([])
  })

  it('lists several gateways and polls the first when none was chosen, persisting the pick', async () => {
    const requested: string[] = []
    const chosen: string[] = []
    const manager = mgr(
      conn(),
      cloud(
        [
          { deviceId: '101', deviceType: 'k40' },
          { deviceId: '102', deviceType: 'k40' },
        ],
        requested,
      ),
      chosen,
    )
    await manager.start()
    expect(manager.getInfo().info['gateways']).toEqual([
      { gatewayId: '101', name: '101', model: 'k40', deviceType: 'k40' },
      { gatewayId: '102', name: '102', model: 'k40', deviceType: 'k40' },
    ])
    expect(manager.getInfo().info['gatewayId']).toBe('101')
    expect(chosen).toEqual(['101'])
    expect(requested.some((u) => u.includes('/resource/heatingCircuits'))).toBe(true)
    expect(requested.some((u) => u.includes('/v2/gateways/'))).toBe(false)
    expect(requested.some((u) => u.includes('gateway-k40'))).toBe(false)
    await manager.stop()
  })

  it('keeps the persisted choice and does not re-persist it', async () => {
    const requested: string[] = []
    const chosen: string[] = []
    const manager = mgr(
      conn({ gatewayId: '102' }),
      cloud(
        [
          { deviceId: '101', deviceType: 'k40' },
          { deviceId: '102', deviceType: 'k40' },
        ],
        requested,
      ),
      chosen,
    )
    await manager.start()
    expect(manager.getInfo().info['gatewayId']).toBe('102')
    expect(chosen).toEqual([])
    expect(requested.some((u) => u.includes('/gateways/102/resource/'))).toBe(true)
    await manager.stop()
  })

  it('refuses a chosen gateway that is no longer on the account instead of switching silently', async () => {
    const manager = mgr(conn({ gatewayId: '999' }), cloud([{ deviceId: '101' }], []))
    await expect(manager.start()).rejects.toThrow(/999/)
    expect(manager.getInfo().status).toBe('error')
  })

  it('reports an account with no gateway', async () => {
    const manager = mgr(conn(), cloud([], []))
    await expect(manager.start()).rejects.toThrow(/no gateway/i)
  })
})
