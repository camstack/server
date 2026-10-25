/**
 * The doorbell forward path had exactly one observable: nothing. A ring that
 * reached a subscribed iPhone and a ring that hap-nodejs dropped on the floor
 * produced byte-identical output (none), which is why the 2026-08-07 press on
 * camera 101 could not be diagnosed from the log at all.
 *
 * These pin the probe that ends that: the zero-subscriber case must be
 * detectable, and a library shape we no longer recognise must degrade instead
 * of throwing on the ring path.
 */
import { describe, it, expect } from 'vitest'
import {
  describeDoorbellDelivery,
  ringReachedNobody,
} from '../mappers/builders/doorbell-delivery.js'

function connection(subscribedTo: ReadonlySet<string>) {
  return {
    hasEventNotifications: (aid: number, iid: number) => subscribedTo.has(`${aid}.${iid}`),
  }
}

function accessory(opts: {
  aid?: number | null
  connections?: ReadonlyArray<ReturnType<typeof connection>>
  noServer?: boolean
}) {
  const aid = opts.aid === undefined ? 1 : opts.aid
  if (opts.noServer) return { aid }
  return { aid, _server: { httpServer: { connections: opts.connections ?? [] } } }
}

describe('describeDoorbellDelivery', () => {
  it('counts ONLY the connections subscribed to this exact aid.iid', () => {
    const report = describeDoorbellDelivery(
      accessory({
        aid: 1,
        connections: [
          connection(new Set(['1.9'])), // subscribed to the doorbell characteristic
          connection(new Set(['1.11'])), // subscribed to something else
          connection(new Set()), // subscribed to nothing
        ],
      }),
      { iid: 9 },
    )
    expect(report.connectionCount).toBe(3)
    expect(report.subscriberCount).toBe(1)
    expect(ringReachedNobody(report)).toBe(false)
  })

  it('reports the SILENT DROP: connections are open but none subscribed', () => {
    const report = describeDoorbellDelivery(
      accessory({ aid: 1, connections: [connection(new Set(['1.11']))] }),
      { iid: 9 },
    )
    expect(report.connectionCount).toBe(1)
    expect(report.subscriberCount).toBe(0)
    expect(ringReachedNobody(report)).toBe(true)
  })

  it('reports the SILENT DROP when no controller is connected at all', () => {
    const report = describeDoorbellDelivery(accessory({ aid: 1, connections: [] }), { iid: 9 })
    expect(report.connectionCount).toBe(0)
    expect(ringReachedNobody(report)).toBe(true)
  })

  it('degrades — never throws — when the accessory has no HAP server yet', () => {
    const report = describeDoorbellDelivery(accessory({ aid: null, noServer: true }), { iid: 9 })
    expect(report.serverPublished).toBe(false)
    expect(report.aid).toBeNull()
    expect(report.subscriberCount).toBe(0)
  })

  it('degrades when hap-nodejs no longer exposes the internals we read', () => {
    const report = describeDoorbellDelivery({ aid: 1, _server: {} }, { iid: 9 })
    expect(report.serverPublished).toBe(true)
    expect(report.connectionCount).toBe(0)
    expect(report.subscriberCount).toBe(0)
  })

  it('counts no subscriber while ids are unassigned (accessory not yet published)', () => {
    const report = describeDoorbellDelivery(
      accessory({ aid: null, connections: [connection(new Set(['1.9']))] }),
      { iid: 9 },
    )
    expect(report.connectionCount).toBe(1)
    expect(report.subscriberCount).toBe(0)
    expect(ringReachedNobody(report)).toBe(true)
  })
})
