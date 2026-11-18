/**
 * D1059: a UniFi console, switch or AP declares its MAC, serial and IP as typed
 * identifiers. A failed controller read (no live snapshot) declares nothing, so
 * the stored values survive (D49); a snapshot the controller sent without a MAC
 * keeps the stored MAC. The writer stores what `device-manager.setIdentifiers`
 * would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { workerDeviceToSnapshot } from '../unifi-client-aiounifi.js'
import { UnifiLiveClient, type UnifiFetch } from '../unifi-client-live.js'
import { unifiInfraIdentifiers, unifiPortAttachedIdentifiers } from '../unifi-identifiers.js'
import { infraSnapshot } from './unifi-fixtures.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

interface StoredWorld {
  stored: DeviceIdentifiers | null
  writes: number
}

async function declare(world: StoredWorld, snapshot: UnifiInfraSnapshot | null): Promise<void> {
  const declaration = unifiInfraIdentifiers(snapshot)
  if (declaration === null) return
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.writes += 1
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 11, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

const SWITCH = infraSnapshot({
  id: 'd1',
  mac: 'f0:9f:c2:00:00:01',
  serial: 'F09FC2000001',
  ip: '192.0.2.10',
  kind: 'switch',
})

describe('unifiInfraIdentifiers', () => {
  it('declares the MAC, the vendor-prefixed serial and the IP of a switch', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await declare(world, SWITCH)
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['f0:9f:c2:00:00:01'])
    expect(world.stored?.serial?.value).toBe('ubiquiti:f09fc2000001')
    expect(world.stored?.ip?.value).toBe('192.0.2.10')
  })

  it('a failed controller read (no live snapshot) keeps every stored value', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await declare(world, SWITCH)
    await declare(world, null)
    expect(world.stored?.mac?.[0]?.value).toBe('f0:9f:c2:00:00:01')
    expect(world.stored?.serial?.value).toBe('ubiquiti:f09fc2000001')
    expect(world.stored?.ip?.value).toBe('192.0.2.10')
  })

  it('a snapshot without MAC, serial or IP (API key alone, not reported) keeps the stored ones', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await declare(world, SWITCH)
    await declare(world, infraSnapshot({ id: 'd1', mac: null, serial: null, ip: null }))
    expect(world.stored?.mac?.[0]?.value).toBe('f0:9f:c2:00:00:01')
    expect(world.stored?.serial?.value).toBe('ubiquiti:f09fc2000001')
    expect(world.stored?.ip?.value).toBe('192.0.2.10')
  })
})

describe('where the identity comes from', () => {
  it('the Integration API device carries its IP address', async () => {
    const routes: Record<string, unknown> = {
      '/sites': { data: [{ id: 's1', internalReference: 'default' }], totalCount: 1 },
      '/sites/s1/devices': {
        data: [{ id: 'd1', macAddress: 'F0:9F:C2:00:00:01', ipAddress: '192.0.2.10' }],
        totalCount: 1,
      },
      '/sites/s1/clients': { data: [], totalCount: 0 },
    }
    const fetchImpl: UnifiFetch = async (url) => {
      const body = routes[url.split('/integration/v1')[1]?.split('?')[0] ?? '']
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }
    const client = new UnifiLiveClient({
      host: 'console.example',
      port: 443,
      apiKey: 'k',
      site: 'default',
      fetchImpl,
    })
    await client.connect()
    const [device] = await client.listInfraDevices()
    expect(device).toMatchObject({ mac: 'f0:9f:c2:00:00:01', ip: '192.0.2.10', serial: null })
  })

  it('a blank IP or MAC from the Integration API is unread, so the stored ones stay', async () => {
    const routes: Record<string, unknown> = {
      '/sites': { data: [{ id: 's1', internalReference: 'default' }], totalCount: 1 },
      '/sites/s1/devices': {
        data: [{ id: 'd1', macAddress: ' ', ipAddress: '' }],
        totalCount: 1,
      },
      '/sites/s1/clients': { data: [], totalCount: 0 },
    }
    const fetchImpl: UnifiFetch = async (url) => {
      const body = routes[url.split('/integration/v1')[1]?.split('?')[0] ?? '']
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }
    const client = new UnifiLiveClient({
      host: 'console.example',
      port: 443,
      apiKey: 'k',
      site: 'default',
      fetchImpl,
    })
    await client.connect()
    const [device] = await client.listInfraDevices()
    expect(device).toMatchObject({ mac: null, ip: null })
    const world: StoredWorld = { stored: null, writes: 0 }
    await declare(world, SWITCH)
    await declare(world, device ?? null)
    expect(world.stored?.ip?.value).toBe('192.0.2.10')
    expect(world.stored?.mac?.[0]?.value).toBe('f0:9f:c2:00:00:01')
  })

  it('the local account (classic API) carries the serial and the IP', () => {
    const snapshot = workerDeviceToSnapshot({
      id: 'c1',
      mac: 'f0:9f:c2:00:00:01',
      ip: '192.0.2.10',
      serial: 'F09FC2000001',
      name: 'sw',
      model: 'USL8LP',
      type: 'usw',
      state: 1,
      uptimeSec: null,
      cpuPercent: null,
      memoryPercent: null,
      cpuTempC: null,
      clients: 0,
      ledOverride: null,
      ports: [],
    })
    expect(snapshot).toMatchObject({ ip: '192.0.2.10', serial: 'F09FC2000001' })
  })
})

describe('unifiPortAttachedIdentifiers (D1063)', () => {
  async function attach(world: StoredWorld, mac: string | null, ip: string | null): Promise<void> {
    const declaration = unifiPortAttachedIdentifiers(mac, ip)
    if (declaration === null) return
    const writer = {
      mutate: async (input: SetIdentifiersInput) => {
        world.writes += 1
        world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
      },
    }
    await declareDeviceIdentifiers(
      { deviceId: 12, logger: quiet, writer },
      declaration.identifiers,
      { unread: declaration.unread },
    )
  }

  it('declares the wired client MAC and its IP', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await attach(world, 'AA:BB:CC:00:11:22', '192.0.2.50')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['aa:bb:cc:00:11:22'])
    expect(world.stored?.ip?.value).toBe('192.0.2.50')
  })

  it('a client IP the controller does not know is unread: the stored IP is kept', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await attach(world, 'AA:BB:CC:00:11:22', '192.0.2.50')
    await attach(world, 'AA:BB:CC:00:11:22', null)
    expect(world.stored?.ip?.value).toBe('192.0.2.50')
  })

  it('a port that never saw a client declares nothing', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await attach(world, null, null)
    expect(world.writes).toBe(0)
  })

  it('a different client on the port replaces the MAC (absent is not unread)', async () => {
    const world: StoredWorld = { stored: null, writes: 0 }
    await attach(world, 'AA:BB:CC:00:11:22', '192.0.2.50')
    await attach(world, 'AA:BB:CC:00:11:99', '192.0.2.51')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['aa:bb:cc:00:11:99'])
    expect(world.stored?.ip?.value).toBe('192.0.2.51')
  })
})
