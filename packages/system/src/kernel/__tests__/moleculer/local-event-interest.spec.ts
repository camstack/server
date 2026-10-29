/**
 * The hub's in-process subscriber set is observable: the child registry reads
 * it to decide what its children may keep off the socket, and is told when it
 * changes. The bridge's pass-through relay is NOT a consumer and never counts.
 */
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrokerEventBus,
  getLocalEventInterest,
  onLocalEventInterestChange,
  subscribePassthrough,
} from '../../moleculer/event-bus.js'

describe('local event interest', () => {
  let broker: ServiceBroker | null = null
  afterEach(async () => {
    await broker?.stop()
    broker = null
  })

  function fresh(): ServiceBroker {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    return broker
  }

  it('lists the patterns in-process subscribers hold, and drops them on unsubscribe', () => {
    const b = fresh()
    const bus = createBrokerEventBus(b, 'admin')
    expect(getLocalEventInterest(b)).toEqual([])
    const off = bus.subscribe({ category: 'pipeline.trace' }, () => {})
    expect(getLocalEventInterest(b)).toEqual(['pipeline.trace'])
    off()
    expect(getLocalEventInterest(b)).toEqual([])
  })

  it('notifies when a pattern gains its first and loses its last subscriber only', () => {
    const b = fresh()
    const bus = createBrokerEventBus(b, 'admin')
    const changed = vi.fn()
    onLocalEventInterestChange(b, changed)

    const off1 = bus.subscribe({ category: 'pipeline.trace' }, () => {})
    const off2 = bus.subscribe({ category: 'pipeline.trace' }, () => {})
    expect(changed).toHaveBeenCalledTimes(1)
    off1()
    expect(changed).toHaveBeenCalledTimes(1)
    off2()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('does not count the pass-through relay as a consumer', () => {
    const b = fresh()
    const changed = vi.fn()
    onLocalEventInterestChange(b, changed)
    subscribePassthrough(b, () => {})
    expect(getLocalEventInterest(b)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })
})
