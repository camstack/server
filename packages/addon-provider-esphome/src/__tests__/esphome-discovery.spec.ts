import { describe, expect, it } from 'vitest'
import {
  ESPHOME_MDNS_SERVICE,
  boardsFromDnsMessage,
  browseBoards,
  mdnsPtrQuery,
  proposeBoards,
} from '../esphome-discovery.js'
import { computeBrokerCleanup, linkBrokersToIntegrations } from '../esphome-reconciler.js'
import { setBrokerDevicesOnline, type OfflineTarget } from '../esphome-broker-devices.js'

function encodeName(name: string): Buffer {
  const parts = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
  return Buffer.concat([...parts, Buffer.from([0])])
}

function record(name: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([encodeName(name), head, data])
}

/** One announcement: PTR + SRV + A, as a board sends it. */
function announcement(instance: string, host: string, port: number, ip: readonly number[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(3, 6)
  const full = `${instance}.${ESPHOME_MDNS_SERVICE}`
  const srvData = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from([port >> 8, port & 0xff]),
    encodeName(host),
  ])
  return Buffer.concat([
    header,
    record(ESPHOME_MDNS_SERVICE, 12, encodeName(full)),
    record(full, 33, srvData),
    record(host, 1, Buffer.from(ip)),
  ])
}

describe('ESPHome mDNS discovery', () => {
  it('asks for the esphomelib service with a unicast-reply question', () => {
    const q = mdnsPtrQuery(ESPHOME_MDNS_SERVICE)
    expect(q.readUInt16BE(4)).toBe(1)
    expect(q.subarray(q.length - 4).readUInt16BE(2)).toBe(0x8001)
  })

  it('reads a board out of an announcement', () => {
    const boards = boardsFromDnsMessage(
      announcement('kitchen-plug', 'kitchen-plug.local', 6053, [10, 0, 0, 7]),
    )
    expect(boards).toEqual([
      { host: '10.0.0.7', port: 6053, name: 'kitchen-plug', id: 'kitchen-plug' },
    ])
  })

  it('collects each host once across packets and survives garbage', async () => {
    const one = announcement('a', 'a.local', 6053, [10, 0, 0, 1])
    const found = await browseBoards(async () => [one, one, Buffer.from([1, 2, 3])])
    expect(found.map((b) => b.host)).toEqual(['10.0.0.1'])
  })

  it('returns nothing when the exchange fails', async () => {
    const found = await browseBoards(async () => {
      throw new Error('no multicast')
    })
    expect(found).toEqual([])
  })

  it('does not propose a board that is already configured', () => {
    const found = [
      { host: '10.0.0.1', port: 6053, name: 'a', id: 'a' },
      { host: '10.0.0.2', port: 6053, name: 'b', id: 'b' },
    ]
    expect(proposeBoards(found, ['10.0.0.1']).map((b) => b.id)).toEqual(['b'])
    expect(proposeBoards(found, ['B.local']).map((b) => b.id)).toEqual(['a'])
  })
})

describe('integration reconcile', () => {
  it('collects only boards whose integration is gone', () => {
    const brokers = [
      { id: 'a', integrationId: 'i1' },
      { id: 'b', integrationId: 'i2' },
      { id: 'c' },
    ]
    expect(computeBrokerCleanup(brokers, new Set(['i1']))).toEqual(['b'])
  })

  it('stamps the FK and keeps untouched entries by reference', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const out = linkBrokersToIntegrations([a, b], [{ id: 'i1', brokerId: 'a' }])
    expect(out[0]).toEqual({ id: 'a', integrationId: 'i1' })
    expect(out[1]).toBe(b)
  })
})

describe('setBrokerDevicesOnline', () => {
  function target(brokerId: string, online: boolean): OfflineTarget & { flips: number } {
    const t = {
      online,
      flips: 0,
      config: { get: (key: string): unknown => (key === 'brokerId' ? brokerId : undefined) },
      markOnline(next: boolean): void {
        t.online = next
        t.flips += 1
      },
    }
    return t
  }

  it('flips only the board in question and only when the state differs', () => {
    const mine = target('a', true)
    const mineOff = target('a', false)
    const other = target('b', true)
    expect(setBrokerDevicesOnline([mine, mineOff, other], 'a', false)).toBe(1)
    expect(mine.online).toBe(false)
    expect(other.online).toBe(true)
    expect(mineOff.flips).toBe(0)
  })
})
