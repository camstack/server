import { EventEmitter } from 'node:events'
import { AcDevice, type DiscoveredDevice } from '@apocaliss92/nodegree'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { settingsToGreeConfig } from '../config.js'
import {
  type GreeFacadeLike,
  GreeIntegrationManager,
  type GreeRetryScheduler,
} from '../gree-integration-manager.js'

const MAC = 'aa:bb:cc:dd:ee:01'
const responder: DiscoveredDevice = { ip: '192.0.2.10', port: 7000, mac: MAC, name: 'Daniel' }

/** A real AcDevice prototype with a live emitter and no network (type boundary: no transport). */
function fakeAc(): AcDevice {
  const ac: AcDevice = Object.create(AcDevice.prototype)
  Object.assign(ac, { emitter: new EventEmitter(), startPolling: vi.fn(), stopPolling: vi.fn() })
  return ac
}

interface Timer {
  readonly fn: () => void
  readonly delayMs: number
  cancelled: boolean
}

function fakeScheduler(): { scheduler: GreeRetryScheduler; timers: Timer[] } {
  const timers: Timer[] = []
  return {
    timers,
    scheduler: {
      after: (fn, delayMs) => {
        const t: Timer = { fn, delayMs, cancelled: false }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      },
    },
  }
}

function fakeLogger() {
  const warn = vi.fn()
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warn }
}

function build(opts: {
  discover: () => Promise<DiscoveredDevice[]>
  ac?: AcDevice
  timeoutMs?: number
}) {
  const { scheduler, timers } = fakeScheduler()
  const { logger, warn } = fakeLogger()
  const created: AcDevice[] = []
  const facades: { closed: number }[] = []
  const makeFacade = (): GreeFacadeLike => {
    const f = { closed: 0 }
    facades.push(f)
    return {
      discover: opts.discover,
      createAc: async () => {
        const ac = opts.ac ?? fakeAc()
        created.push(ac)
        return ac
      },
      close: async () => {
        f.closed++
      },
    }
  }
  const onConnected = vi.fn()
  const onDisconnected = vi.fn()
  const manager = new GreeIntegrationManager({
    id: 'k1',
    name: 'Daniel',
    deviceId: 554,
    connection: settingsToGreeConfig({ host: '192.0.2.10', timeoutMs: opts.timeoutMs ?? 3000 }),
    logger,
    onConnected,
    onDisconnected,
    surfaceSink: { set: vi.fn() },
    pollIntervalMs: 0,
    expectMac: MAC,
    makeFacade,
    scheduler,
  })
  return { manager, timers, warn, created, facades, onConnected, onDisconnected }
}

describe('GreeIntegrationManager retry', () => {
  it('retries a zero-responder start with 5s, 30s, then 3min backoff, and logs each miss', async () => {
    let up = false
    const h = build({ discover: async () => (up ? [responder] : []) })
    await h.manager.start()
    expect(h.timers.map((t) => t.delayMs)).toEqual([5_000])
    expect(h.manager.getInfo().status).toBe('error')
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('no responder'),
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: 554 }),
        meta: expect.objectContaining({ discovered: 0, expectMac: MAC, host: '192.0.2.10' }),
      }),
    )
    h.timers[0]!.fn()
    await vi.waitFor(() => expect(h.timers.map((t) => t.delayMs)).toEqual([5_000, 30_000]))
    h.timers[1]!.fn()
    await vi.waitFor(() => expect(h.timers.map((t) => t.delayMs)).toEqual([5_000, 30_000, 180_000]))
    h.timers[2]!.fn()
    await vi.waitFor(() => expect(h.timers).toHaveLength(4))
    expect(h.timers[3]!.delayMs).toBe(180_000)

    up = true
    h.timers[3]!.fn()
    await vi.waitFor(() => expect(h.manager.getInfo().status).toBe('connected'))
    expect(h.onConnected).toHaveBeenCalledTimes(1)
    expect(h.timers).toHaveLength(4)
  })

  it('retries when the scan throws, and stop() cancels the pending retry', async () => {
    const h = build({
      discover: async () => {
        throw new Error('socket down')
      },
    })
    await expect(h.manager.start()).rejects.toThrow('socket down')
    expect(h.timers).toHaveLength(1)
    await h.manager.stop()
    expect(h.timers[0]!.cancelled).toBe(true)
  })

  it('sends the discover datagram several times within the window and stops on a match', async () => {
    const discover = vi
      .fn<() => Promise<DiscoveredDevice[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([responder])
    const h = build({ discover, timeoutMs: 3000 })
    await h.manager.start()
    expect(discover).toHaveBeenCalledTimes(2)
    expect(h.manager.getInfo().status).toBe('connected')
  })

  it('logs offline, never throws on error, and a state change resets the failure count', async () => {
    const ac = fakeAc()
    const h = build({ discover: async () => [responder], ac })
    await h.manager.start()
    expect(() => ac.emit('error', new Error('boom'))).not.toThrow()
    ac.emit('offline', undefined)
    ac.emit('offline', undefined)
    ac.emit('stateChanged', { changed: {} })
    ac.emit('offline', undefined)
    ac.emit('offline', undefined)
    expect(h.onDisconnected).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(0)
  })

  it('after 3 consecutive offline events marks the AC offline, drops the handle and re-binds', async () => {
    const ac = fakeAc()
    const h = build({ discover: async () => [responder], ac })
    await h.manager.start()
    ac.emit('offline', undefined)
    ac.emit('offline', undefined)
    expect(h.timers).toHaveLength(0)
    ac.emit('offline', undefined)
    expect(h.onDisconnected).toHaveBeenCalledTimes(1)
    expect(h.timers.map((t) => t.delayMs)).toEqual([5_000])
    expect(h.manager.getInfo().status).toBe('error')
    h.timers[0]!.fn()
    await vi.waitFor(() => expect(h.facades[0]!.closed).toBe(1))
    await vi.waitFor(() => expect(h.manager.getInfo().status).toBe('connected'))
  })
})
