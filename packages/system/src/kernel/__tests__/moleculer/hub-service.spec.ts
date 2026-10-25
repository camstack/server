import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createHubService } from '../../moleculer/hub-service.js'
import {
  getBrokerEventBus,
  registerEventBusService,
  clusterEventTopic,
} from '../../moleculer/addon-context-factory.js'
import type { SystemEvent } from '@camstack/types'

describe('$hub service', () => {
  let hub: ServiceBroker
  let agent: ServiceBroker

  afterEach(async () => {
    if (agent) await agent.stop()
    if (hub) await hub.stop()
  })

  it('receives events from agents via camstack.evt.* broadcast', async () => {
    // Events flow via one Moleculer event per category —
    // `broker.broadcast('camstack.evt.<category>', ...)`. Install the
    // `$event-bus` service + a wildcard subscriber so the hub captures
    // every event seen on the channel.
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    registerEventBusService(hub)
    registerEventBusService(agent)

    const receivedEvents: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (event) => {
      receivedEvents.push(event)
    })

    await hub.start()
    await agent.start()

    agent.broadcast(clusterEventTopic('detection.result'), {
      id: 'det-1',
      timestamp: new Date(),
      source: { type: 'addon', id: 'detection-pipeline' },
      category: 'detection.result',
      data: { count: 3 },
      sourceNodeId: 'agent',
    })

    // Cross-broker broadcast transit is async — wait a beat for the Fake
    // transporter to deliver to the hub's `$event-bus` handler.
    await new Promise((r) => setTimeout(r, 100))

    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0]!.category).toBe('detection.result')
  })

  it('serves addon config via $hub.getAddonConfig', async () => {
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    hub.createService(
      createHubService({
        getAddonConfig: (addonId) => ({ url: `http://${addonId}` }),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    await hub.start()
    await agent.start()

    const config = await agent.call('$hub.getAddonConfig', { addonId: 'my-addon' })
    expect(config).toEqual({ url: 'http://my-addon' })
  })

  it('serves settings via $hub.getSettings', async () => {
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: (scope, key) => ({ scope, key, value: 42 }),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    await hub.start()
    await agent.start()

    const settings = await agent.call('$hub.getSettings', {
      scope: 'global',
      key: 'detection.threshold',
    })
    expect(settings).toEqual({ scope: 'global', key: 'detection.threshold', value: 42 })
  })

  it('receives logs from agents via $hub.log', async () => {
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    const logs: unknown[] = []
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: (entry) => {
          logs.push(entry)
        },
      }),
    )

    await hub.start()
    await agent.start()

    await agent.call('$hub.log', {
      level: 'info',
      message: 'hello from agent',
      addonId: 'detection-pipeline',
      nodeId: 'agent',
    })

    expect(logs).toHaveLength(1)
    expect((logs[0] as Record<string, unknown>).message).toBe('hello from agent')
  })

  it('returns recent events via $hub.getRecentEvents', async () => {
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: (category) => [{ category, data: 'test' }],
        onLog: () => {},
      }),
    )

    await hub.start()
    await agent.start()

    const events = await agent.call('$hub.getRecentEvents', {
      category: 'detection.result',
      limit: 10,
    })
    expect(events).toEqual([{ category: 'detection.result', data: 'test' }])
  })

  // Device persistence tests removed — persistence is now handled by
  // the `device-manager` capability addon, not `$hub.*` actions.
  // See `device-manager.addon.ts` in `@camstack/system/builtins/`.
})
