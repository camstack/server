import { EventEmitter } from 'node:events'
import { AcDevice, type DiscoveredDevice } from '@apocaliss92/nodegree'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { settingsToGreeConfig } from '../config.js'
import {
  type GreeMoved,
  GreeIntegrationManager,
  REBIND_FALLBACK_AFTER,
} from '../gree-integration-manager.js'

const MAC = 'aa:bb:cc:dd:ee:01'
const moved: DiscoveredDevice = {
  ip: '198.51.100.20',
  port: 7000,
  mac: MAC,
  name: 'Daniel',
}

function fakeAc(): AcDevice {
  const ac: AcDevice = Object.create(AcDevice.prototype)
  Object.assign(ac, {
    emitter: new EventEmitter(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
  })
  return ac
}

function build(sweep: () => Promise<readonly DiscoveredDevice[]>) {
  const timers: Array<() => void> = []
  const warn = vi.fn()
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const onMoved = vi.fn<(move: GreeMoved) => void>()
  const createdAt: string[] = []
  const manager = new GreeIntegrationManager({
    id: 'k1',
    name: 'Daniel',
    deviceId: 554,
    connection: settingsToGreeConfig({
      host: '192.0.2.10',
      broadcastAddr: '192.0.2.255',
    }),
    logger,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    surfaceSink: { set: vi.fn() },
    pollIntervalMs: 0,
    expectMac: MAC,
    makeFacade: () => ({
      discover: async () => [],
      createAc: async (target) => {
        createdAt.push(target.ip)
        return fakeAc()
      },
      close: async () => undefined,
    }),
    scheduler: {
      after: (fn) => {
        timers.push(fn)
        return () => undefined
      },
    },
    fallbackSweep: sweep,
    onMoved,
  })
  return { manager, timers, onMoved, warn, createdAt }
}

describe('Gree re-bind subnet fallback', () => {
  it('does not sweep the subnets before the host re-binds have failed N times', async () => {
    const sweep = vi.fn(async () => [moved])
    const h = build(sweep)
    await h.manager.start()
    for (let i = 1; i < REBIND_FALLBACK_AFTER; i += 1) {
      h.timers.at(-1)?.()
      await vi.waitFor(() => expect(h.timers).toHaveLength(i + 1))
    }
    expect(sweep).not.toHaveBeenCalled()
  })

  it('after N failures sweeps, follows the MAC to the new address and reports the move', async () => {
    const sweep = vi.fn(async () => [moved])
    const h = build(sweep)
    await h.manager.start()
    for (let i = 1; i <= REBIND_FALLBACK_AFTER; i += 1) {
      h.timers.at(-1)?.()
      await vi.waitFor(() => expect(sweep.mock.calls.length + h.timers.length).toBeGreaterThan(i))
    }
    await vi.waitFor(() => expect(h.manager.getInfo().status).toBe('connected'))
    expect(h.createdAt).toEqual(['198.51.100.20'])
    expect(h.manager.getConnection().host).toBe('198.51.100.20')
    expect(h.manager.getConnection().broadcastAddr).toBe('')
    expect(h.onMoved).toHaveBeenCalledWith(
      expect.objectContaining({ oldIp: '192.0.2.10', newIp: '198.51.100.20' }),
    )
    expect(h.warn).toHaveBeenCalledWith(
      'Gree AC moved',
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: 554 }),
      }),
    )
  })
})
