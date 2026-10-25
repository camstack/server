/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test mock typing */
import { describe, it, expect, vi } from 'vitest'
import { createEventBusProxyRouter } from '../api/core/event-bus-proxy.router.js'
import { makeCtx } from './cap-routers/harness.js'
import type { IEventBus } from '@camstack/types'

function createMockEventBus() {
  return {
    emit: vi.fn(),
  } as unknown as IEventBus & { emit: ReturnType<typeof vi.fn> }
}

describe('event-bus-proxy router', () => {
  it('emit calls eventBus.emit with the correct shape', async () => {
    const bus = createMockEventBus()
    const router = createEventBusProxyRouter(bus)
    const caller = router.createCaller(makeCtx('admin'))

    await caller.emit({
      id: 'evt-1',
      timestamp: '2026-01-15T10:00:00.000Z',
      source: { type: 'addon', id: 'my-addon' },
      // biome-ignore lint/plugin: synthetic test-only event category
      category: 'motion',
      data: { zone: 'front' },
    })

    expect(bus.emit).toHaveBeenCalledOnce()
    expect(bus.emit).toHaveBeenCalledWith({
      id: 'evt-1',
      timestamp: expect.any(Date),
      source: { type: 'addon', id: 'my-addon' },
      category: 'motion',
      data: { zone: 'front' },
    })
  })

  it('emit returns { ok: true }', async () => {
    const bus = createMockEventBus()
    const router = createEventBusProxyRouter(bus)
    const caller = router.createCaller(makeCtx('admin'))

    const result = await caller.emit({
      id: 'evt-2',
      timestamp: '2026-01-15T10:00:00.000Z',
      source: { type: 'device', id: 'cam-1' },
      // biome-ignore lint/plugin: synthetic test-only event category
      category: 'alert',
      data: {},
    })

    expect(result).toEqual({ ok: true })
  })

  // SECURITY (F0.1): `emit` injects a fully-attributed SystemEvent — including a
  // spoofable `source` — onto the hub's real bus. A non-admin authenticated
  // token must be refused. Neutralisation: revert `emit` to `protectedProcedure`
  // and this expectation flips to a successful emit.
  it('emit is admin-only — a non-admin authenticated token is FORBIDDEN', async () => {
    const bus = createMockEventBus()
    const router = createEventBusProxyRouter(bus)
    const caller = router.createCaller(makeCtx('user'))

    await expect(
      caller.emit({
        id: 'evt-spoof',
        timestamp: '2026-01-15T10:00:00.000Z',
        source: { type: 'device', id: 'cam-101' },
        // biome-ignore lint/plugin: synthetic test-only event category
        category: 'motion',
        data: { spoofed: true },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(bus.emit).not.toHaveBeenCalled()
  })

  it('timestamp string is converted to a Date object', async () => {
    const bus = createMockEventBus()
    const router = createEventBusProxyRouter(bus)
    const caller = router.createCaller(makeCtx('admin'))

    const isoString = '2026-06-20T14:30:00.000Z'

    await caller.emit({
      id: 'evt-3',
      timestamp: isoString,
      source: { type: 'addon', id: 'test' },
      // biome-ignore lint/plugin: synthetic test-only event category
      category: 'info',
      data: {},
    })

    const emittedEvent: unknown = bus.emit.mock.calls[0]?.[0]
    const timestamp: unknown =
      typeof emittedEvent === 'object' && emittedEvent !== null
        ? Reflect.get(emittedEvent, 'timestamp')
        : undefined
    expect(timestamp).toBeInstanceOf(Date)
    expect(timestamp instanceof Date ? timestamp.toISOString() : null).toBe(isoString)
  })
})
