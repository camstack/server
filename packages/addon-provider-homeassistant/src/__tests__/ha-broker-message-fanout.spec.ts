import { describe, it, expect } from 'vitest'
import type { IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { HaIntegrationManager } from '../ha-integration-manager.js'

/**
 * One upstream HA state change is ONE `broker.message` on the shared bus,
 * however many subscriptions match it: every consumer receives every event
 * and filters by `key`, so a per-subscription copy is pure duplicate traffic.
 * A NEW subscriber still gets its initial state, targeted at its own id.
 */

interface BrokerMessageData {
  readonly subscriptionId: string
  readonly key: string
  readonly payload: unknown
}

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

function buildHarness(): { manager: HaIntegrationManager; emitted: BrokerMessageData[] } {
  const emitted: BrokerMessageData[] = []
  const eventBus: IEventBus = {
    emit(event: SystemEvent) {
      if (event.category === 'broker.message') {
        const data = event.data
        if (typeof data === 'object' && data !== null && 'key' in data) {
          emitted.push({
            subscriptionId: String(Reflect.get(data, 'subscriptionId')),
            key: String(Reflect.get(data, 'key')),
            payload: Reflect.get(data, 'payload'),
          })
        }
      }
    },
    subscribe: () => () => {},
    getRecent: (): readonly SystemEvent[] => [],
  }
  const manager = new HaIntegrationManager({
    id: 'ha_fanout',
    name: 'Fanout',
    auth: { kind: 'long-lived', baseUrl: 'http://192.0.2.10:8123', accessToken: 'throwaway' },
    logger: buildLogger(),
    eventBus,
  })
  return { manager, emitted }
}

describe('HaIntegrationManager broker.message fan-out', () => {
  it('emits ONE event for one upstream change however many subscriptions match', async () => {
    const { manager, emitted } = buildHarness()
    await manager.subscribe({ entityIds: ['light.kitchen'] })
    await manager.subscribe({ entityIds: ['light.kitchen'] })
    await manager.subscribe({ domain: 'light' })

    manager['handleUpstreamUpdate']({ a: { 'light.kitchen': { s: 'on', lc: 1 } } })

    expect(emitted.filter((e) => e.key === 'light.kitchen')).toHaveLength(1)
  })

  it('emits nothing when no subscription matches the entity', async () => {
    const { manager, emitted } = buildHarness()
    await manager.subscribe({ entityIds: ['light.kitchen'] })

    manager['handleUpstreamUpdate']({ a: { 'switch.garage': { s: 'on', lc: 1 } } })

    expect(emitted).toHaveLength(0)
  })

  it('replays the cache to a new subscriber, targeted at its own subscriptionId', async () => {
    const { manager, emitted } = buildHarness()
    await manager.subscribe({ entityIds: ['light.kitchen'] })
    manager['handleUpstreamUpdate']({ a: { 'light.kitchen': { s: 'on', lc: 1 } } })
    emitted.length = 0

    const { subscriptionId } = await manager.subscribe({ entityIds: ['light.kitchen'] })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.key).toBe('light.kitchen')
    expect(emitted[0]?.subscriptionId).toBe(subscriptionId)
  })
})
