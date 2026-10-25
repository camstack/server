import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'

/**
 * Case 2 — the integration manager subscribes to the curated HA BUS event
 * types ({@link BUS_EVENT_TYPES}) on connect and fans each fire up to the
 * addon via `onBusEvent`.
 *
 * We mock `home-assistant-js-websocket` so the manager's internal
 * `HaWsClient` resolves a FAKE `Connection`. The fake records every
 * `subscribeMessage` call (type + per-event-type callback) so we can assert
 * the curated subscriptions are issued and then simulate a `zha_event` fire.
 */

/** A recorded `subscribeMessage` call: the HA message and the callback the
 *  manager registered for it. */
interface RecordedSubscription {
  readonly message: Record<string, unknown>
  readonly callback: (result: { event_type: string; data?: Record<string, unknown> }) => void
}

const recorded: RecordedSubscription[] = []

/** Build a minimal fake `Connection` whose `subscribeMessage` records the
 *  message + callback. The entity baseline subscription (no `event_type`) and
 *  the curated bus subscriptions both land here. */
function makeFakeConnection(): unknown {
  return {
    subscribeMessage: vi.fn(
      async (
        callback: (result: { event_type: string; data?: Record<string, unknown> }) => void,
        message: Record<string, unknown>,
      ) => {
        recorded.push({ message, callback })
        return async () => {}
      },
    ),
    sendMessagePromise: vi.fn(async () => ({})),
    addEventListener: vi.fn(),
    close: vi.fn(),
  }
}

vi.mock('home-assistant-js-websocket', () => ({
  createConnection: vi.fn(async () => makeFakeConnection()),
  createLongLivedTokenAuth: vi.fn((baseUrl: string, accessToken: string) => ({
    baseUrl,
    accessToken,
  })),
  ERR_HASS_HOST_REQUIRED: 1,
  ERR_INVALID_AUTH: 2,
  ERR_CANNOT_CONNECT: 3,
}))

// Imported AFTER the mock is registered.
const { HaIntegrationManager } = await import('../ha-integration-manager.js')

function buildLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function buildEventBus(): IEventBus {
  return {
    emit() {},
    subscribe: () => () => {},
    getRecent: (): readonly SystemEvent[] => [],
  }
}

/** The curated bus subscriptions are those whose message carries an
 *  `event_type` (the entity baseline subscription has none). */
function busSubscriptions(): RecordedSubscription[] {
  return recorded.filter((r) => typeof r.message['event_type'] === 'string')
}

/**
 * `start()` is intentionally NON-BLOCKING — it fires the WS connect in the
 * background so an unreachable host can't hang `broker.add` / addon-boot
 * `restore()`. The `onConnected` chain (baseline + curated bus subscriptions)
 * therefore runs on a later microtask; a single macrotask tick drains it so
 * assertions see the established subscriptions.
 */
const settleConnect = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('HaIntegrationManager — curated bus-event subscriptions (Case 2)', () => {
  beforeEach(() => {
    recorded.length = 0
  })

  it('subscribes to each curated bus event type on connect', async () => {
    const mgr = new HaIntegrationManager({
      id: 'ha_001',
      name: 'HA',
      auth: { kind: 'long-lived', baseUrl: 'http://localhost:8123', accessToken: 'tok' },
      logger: buildLogger(),
      eventBus: buildEventBus(),
      onBusEvent: () => {},
    })
    await mgr.start()
    await settleConnect()

    const types = busSubscriptions().map((r) => r.message['event_type'])
    expect(types).toContain('zha_event')
    expect(types).toContain('deconz_event')
    expect(types).toContain('xiaomi_aqara.click')
    // All subscriptions go through `subscribe_events`.
    for (const sub of busSubscriptions()) {
      expect(sub.message['type']).toBe('subscribe_events')
    }
  })

  it('fans a zha_event fire up to onBusEvent with the verbatim eventType + data', async () => {
    const onBusEvent = vi.fn()
    const mgr = new HaIntegrationManager({
      id: 'ha_001',
      name: 'HA',
      auth: { kind: 'long-lived', baseUrl: 'http://localhost:8123', accessToken: 'tok' },
      logger: buildLogger(),
      eventBus: buildEventBus(),
      onBusEvent,
    })
    await mgr.start()
    await settleConnect()

    const zha = busSubscriptions().find((r) => r.message['event_type'] === 'zha_event')
    expect(zha).toBeDefined()

    // Simulate a HA bus fire — complex ZHA payload.
    const payload = {
      device_ieee: '00:11:22:33:44:55:66:77',
      command: 'press',
      args: [1, 2, 3],
    }
    zha!.callback({ event_type: 'zha_event', data: payload })

    expect(onBusEvent).toHaveBeenCalledTimes(1)
    expect(onBusEvent).toHaveBeenCalledWith('ha_001', {
      eventType: 'zha_event',
      data: payload, // VERBATIM — no normalization
    })
  })

  it('passes data: null when the HA bus event carries no data', async () => {
    const onBusEvent = vi.fn()
    const mgr = new HaIntegrationManager({
      id: 'ha_002',
      name: 'HA',
      auth: { kind: 'long-lived', baseUrl: 'http://localhost:8123', accessToken: 'tok' },
      logger: buildLogger(),
      eventBus: buildEventBus(),
      onBusEvent,
    })
    await mgr.start()
    await settleConnect()

    const deconz = busSubscriptions().find((r) => r.message['event_type'] === 'deconz_event')
    deconz!.callback({ event_type: 'deconz_event' })

    expect(onBusEvent).toHaveBeenCalledWith('ha_002', { eventType: 'deconz_event', data: null })
  })

  it('does NOT subscribe to bus events when no onBusEvent hook is registered', async () => {
    const mgr = new HaIntegrationManager({
      id: 'ha_003',
      name: 'HA',
      auth: { kind: 'long-lived', baseUrl: 'http://localhost:8123', accessToken: 'tok' },
      logger: buildLogger(),
      eventBus: buildEventBus(),
      // no onBusEvent
    })
    await mgr.start()
    await settleConnect()

    expect(busSubscriptions()).toHaveLength(0)
  })
})
