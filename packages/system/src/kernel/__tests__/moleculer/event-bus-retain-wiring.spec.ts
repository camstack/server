/**
 * Wiring-level assertion for the one-shot event contract:
 *  - the hub main broker bus is created with `retainRecent: true` and therefore
 *    backs `getRecent` with a bounded recent[] registry;
 *  - a UDS child bus (`createUdsEventBus`) retains NOTHING — `getRecent` on a
 *    child is always empty because child runners + agents are fire-and-forget.
 */

import type { SystemEvent } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { getBrokerEventBus } from '../../moleculer/event-bus.js'
import type { UdsEventChannel } from '../../transport/uds-event-bus.js'
import { createUdsEventBus } from '../../transport/uds-event-bus.js'

function makeEvent(seq: number): SystemEvent {
  return {
    id: `w-${seq}`,
    timestamp: new Date(seq),
    source: { type: 'core', id: 'test' },
    category: 'device.state-changed',
    data: { seq },
  }
}

describe('event-bus retain wiring — hub-main retains, child retains nothing', () => {
  let broker: ServiceBroker | null = null

  afterEach(async () => {
    if (broker) {
      try {
        await broker.stop()
      } catch {
        /* not started */
      }
      broker = null
    }
  })

  it('hub main broker bus (retainRecent:true) backs getRecent with a bounded registry', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    await broker.start()

    const bus = getBrokerEventBus(broker, { retainRecent: true })
    for (let i = 0; i < 1500; i++) bus.emit(makeEvent(i))

    const recent = bus.getRecent()
    expect(recent.length).toBe(1000)
    expect(recent[recent.length - 1]?.id).toBe('w-1499')
  })

  it('UDS child bus retains NOTHING — getRecent is always empty (one-shot)', () => {
    const channel: UdsEventChannel = {
      emitEvent: () => {},
      onEvent: () => {},
      updateEventPatterns: () => {},
    }
    const received: SystemEvent[] = []
    const bus = createUdsEventBus(channel, 'some-addon')
    bus.subscribe({ category: 'device.state-changed' }, (e) => received.push(e))

    for (let i = 0; i < 1500; i++) bus.emit(makeEvent(i))

    // Delivered to local subscribers…
    expect(received.length).toBe(1500)
    // …but never retained: a child's getRecent is always empty.
    expect(bus.getRecent().length).toBe(0)
  })
})
