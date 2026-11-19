/**
 * The controller link as the operator experiences it: a controller that stops
 * answering (removed, unplugged) must take the integration and its devices
 * offline, and a reply must bring them back. One failed poll never flips.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ShcClient, type ShcLinkDetail } from '../shc-client.js'
import { ShcIntegrationManager } from '../shc-integration-manager.js'
import { setIntegrationDevicesOnline, type OfflineTarget } from '../shc-integration-offline.js'

const CONFIG = { host: '192.0.2.59', sslCertificate: 'C', sslKey: 'K' }

type Mode = 'ok' | 'fail'

/** A controller whose RPC endpoint can be switched between answering and refusing. */
function controller(initial: Mode = 'ok') {
  const state = { mode: initial }
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/devices') || url.endsWith('/rooms')) return Response.json([])
    if (state.mode === 'fail') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    const body = JSON.parse(String(init?.body)) as { method?: string }
    if (body.method === 'RE/subscribe') return Response.json({ result: 'sub-1', jsonrpc: '2.0' })
    // An empty long-poll reply: nothing changed, but the controller is alive.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    return Response.json({ result: [], jsonrpc: '2.0' })
  })
  return { state, fetchImpl }
}

function logger() {
  const warn = vi.fn()
  const info = vi.fn()
  const self: IScopedLogger = {
    debug: vi.fn(),
    info,
    warn,
    error: vi.fn(),
    child: () => self,
    withTags: () => self,
  }
  return { log: self, warn, info }
}

function device(brokerId: string): OfflineTarget & { online: boolean } {
  const dev = {
    online: true,
    config: {
      get: (k: string) => (k === 'system' ? 'bosch-shc' : k === 'brokerId' ? brokerId : undefined),
    },
    markOnline(on: boolean) {
      dev.online = on
    },
  }
  return dev
}

describe('ShcClient link state', () => {
  it('reports up on an empty long-poll reply, and down only after two failed RPCs', async () => {
    const { state, fetchImpl } = controller()
    const client = new ShcClient(CONFIG, { fetchImpl, retryDelayMs: 1 })
    const seen: boolean[] = []
    const details: Array<ShcLinkDetail | null> = []
    client.onLinkState((up, detail) => {
      seen.push(up)
      details.push(detail)
    })
    client.startLongPoll()
    await vi.waitFor(() => expect(seen).toContain(true))
    state.mode = 'fail'
    await vi.waitFor(() => expect(seen).toContain(false))
    client.close()
    expect(details[seen.indexOf(false)]?.consecutiveFailures).toBe(2)
  })

  it('one failed poll does not flip the link', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string }
      calls += 1
      if (calls === 2) throw new Error('blip')
      if (body.method === 'RE/subscribe') return Response.json({ result: 'sub-1' })
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      return Response.json({ result: [] })
    })
    const client = new ShcClient(CONFIG, { fetchImpl, retryDelayMs: 1 })
    const seen: boolean[] = []
    client.onLinkState((up) => seen.push(up))
    client.startLongPoll()
    await vi.waitFor(() => expect(calls).toBeGreaterThan(5))
    client.close()
    expect(seen).not.toContain(false)
  })
})

describe('ShcIntegrationManager link state', () => {
  it('goes error + disconnected when the controller stops answering, warns once, recovers on a reply', async () => {
    const ctl = controller()
    const { log, warn } = logger()
    const onConnected = vi.fn()
    const onDisconnected = vi.fn()
    const manager = new ShcIntegrationManager({
      id: 'int_1',
      name: 'SHC',
      connection: CONFIG,
      logger: log,
      onConnected,
      onDisconnected,
      surfaceSink: { set: vi.fn() },
      makeClient: (config, deps) =>
        new ShcClient(config, { ...deps, fetchImpl: ctl.fetchImpl, retryDelayMs: 1 }),
    })
    await manager.start()
    expect(manager.getInfo().status).toBe('connected')
    expect(onConnected).toHaveBeenCalledTimes(1)

    ctl.state.mode = 'fail'
    await vi.waitFor(() => expect(manager.getInfo().status).toBe('error'))
    expect(manager.getInfo().error).toContain('ECONNREFUSED')
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(onDisconnected).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ tags: { integrationId: 'int_1' } })

    ctl.state.mode = 'ok'
    await vi.waitFor(() => expect(manager.getInfo().status).toBe('connected'))
    expect(manager.getInfo().error).toBeNull()
    expect(onConnected).toHaveBeenCalledTimes(2)
    await manager.stop()
  })

  it('takes every device of the integration offline and back, and only that integration', async () => {
    const ctl = controller()
    const mine = [device('int_1'), device('int_1'), device('int_1')]
    const other = device('int_2')
    const all = [...mine, other]
    const manager = new ShcIntegrationManager({
      id: 'int_1',
      name: 'SHC',
      connection: CONFIG,
      logger: logger().log,
      onConnected: (id) => setIntegrationDevicesOnline(all, id, true),
      onDisconnected: (id) => setIntegrationDevicesOnline(all, id, false),
      surfaceSink: { set: vi.fn() },
      makeClient: (config, deps) =>
        new ShcClient(config, { ...deps, fetchImpl: ctl.fetchImpl, retryDelayMs: 1 }),
    })
    await manager.start()
    ctl.state.mode = 'fail'
    await vi.waitFor(() => expect(mine.every((d) => !d.online)).toBe(true))
    expect(other.online).toBe(true)
    ctl.state.mode = 'ok'
    await vi.waitFor(() => expect(mine.every((d) => d.online)).toBe(true))
    await manager.stop()
  })
})
