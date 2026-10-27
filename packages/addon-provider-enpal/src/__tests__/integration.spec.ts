import type { IScopedLogger } from '@camstack/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import type { FetchLike } from '../enpal-client.js'
import { EnpalClientRegistry } from '../enpal-client-registry.js'
import { enpalConnections } from '../enpal-resolver.js'
import { cascadeRemoveDevicesForIntegration } from '../enpal-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from '../enpal-integration-offline.js'

const csv = readFileSync(join(__dirname, 'fixtures', 'influx-last-values.csv'), 'utf8')

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

afterEach(() => {
  vi.useRealTimers()
  enpalConnections.clear()
})

function registryHarness(initial: 'up' | 'down') {
  let state = initial
  const fetchFake: FetchLike = async () => {
    if (state === 'down') throw new TypeError('fetch failed')
    return new Response(csv, { status: 200 })
  }
  const events: string[] = []
  const registry = new EnpalClientRegistry(quiet, {
    fetch: fetchFake,
    onConnected: (id) => events.push(`connected:${id}`),
    onDisconnected: (id) => events.push(`disconnected:${id}`),
  })
  return {
    registry,
    events,
    set: (s: 'up' | 'down') => {
      state = s
    },
  }
}

const CONNECTION = settingsToConnection({
  host: '192.0.2.10',
  token: 't',
  pollIntervalMs: 10_000,
})

describe('EnpalClientRegistry', () => {
  it('a connected integration publishes its snapshot under its own id', async () => {
    const h = registryHarness('up')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    expect(enpalConnections.getSnapshot('int-1')).not.toBeNull()
    expect(h.events).toEqual(['connected:int-1'])
    await h.registry.shutdown()
  })

  it('a poll that fails after a good one reports the integration disconnected and drops the snapshot', async () => {
    vi.useFakeTimers()
    const h = registryHarness('up')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    h.set('down')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.events).toEqual(['connected:int-1', 'disconnected:int-1'])
    expect(enpalConnections.getSnapshot('int-1')).toBeNull()
    await h.registry.shutdown()
  })

  it('an integration whose box never answered is reported disconnected at start', async () => {
    const h = registryHarness('down')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    expect(h.events).toEqual(['disconnected:int-1'])
    await h.registry.shutdown()
  })

  it('retain drops a vanished integration: its poller stops and its snapshot is gone', async () => {
    const h = registryHarness('up')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    await h.registry.upsert('int-2', 'Cabin', CONNECTION, false)
    await h.registry.retain(new Set(['int-2']))
    expect(h.registry.list()).toEqual(['int-2'])
    expect(enpalConnections.getManager('int-1')).toBeNull()
    expect(enpalConnections.getSnapshot('int-2')).not.toBeNull()
    await h.registry.shutdown()
  })

  it('an unchanged connection keeps the running poller; a changed one restarts it', async () => {
    const h = registryHarness('up')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    const first = enpalConnections.getManager('int-1')
    await h.registry.upsert('int-1', 'Home', CONNECTION, false)
    expect(enpalConnections.getManager('int-1')).toBe(first)
    await h.registry.upsert('int-1', 'Home', { ...CONNECTION, invertBatteryPower: true }, false)
    const second = enpalConnections.getManager('int-1')
    expect(second).not.toBe(first)
    expect(second?.connection.invertBatteryPower).toBe(true)
    await h.registry.shutdown()
  })
})

describe('integration device cascade', () => {
  const rows = [
    { id: 1, parentDeviceId: null },
    { id: 2, parentDeviceId: 1 },
    { id: 3, parentDeviceId: null },
    { id: 4, parentDeviceId: null },
  ]
  const configs: Record<number, Record<string, unknown>> = {
    1: { system: 'enpal', integrationId: 'int-1' },
    2: { system: 'enpal', integrationId: 'int-1' },
    3: { system: 'enpal', integrationId: 'int-2' },
    4: { system: 'other', integrationId: 'int-1' },
  }

  it('removes the integration containers (children go with them), nothing else', async () => {
    const removed: number[] = []
    const count = await cascadeRemoveDevicesForIntegration({
      reg: { getAllForAddon: () => rows },
      devices: {
        loadConfig: async (id: number) => configs[id] ?? {},
        remove: async (id: number) => {
          removed.push(id)
        },
      },
      addonId: 'provider-enpal',
      integrationId: 'int-1',
      logger: quiet,
    })
    expect(removed).toEqual([1])
    expect(count).toBe(1)
  })
})

describe('integration offline marking', () => {
  function target(config: Record<string, unknown>, online: boolean) {
    const t = {
      online,
      config: { get: (k: string) => config[k] },
      markOnline(next: boolean) {
        t.online = next
      },
    }
    return t
  }

  it('marks only this integration devices, children included, and only on a change', () => {
    const a = target({ system: 'enpal', integrationId: 'int-1' }, true)
    const child = target({ system: 'enpal', integrationId: 'int-1' }, true)
    const other = target({ system: 'enpal', integrationId: 'int-2' }, true)
    const idle = target({ system: 'enpal', integrationId: 'int-1' }, false)
    const n = setIntegrationDevicesOnline([a, child, other, idle], 'int-1', false)
    expect(n).toBe(2)
    expect([a.online, child.online, other.online, idle.online]).toEqual([false, false, true, false])
  })
})
