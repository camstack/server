import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { setBrokerDevicesOnline, type OfflineTarget } from '../esphome-broker-devices.js'
import {
  boardCandidates,
  boardsFromHits,
  ESPHOME_DISCOVERY_MODES,
  proposeBoards,
} from '../esphome-discovery.js'

function boardHit(host: string, instance: string, serviceHost: string, port: number): DiscoveryHit {
  return { modeIndex: 0, host, port, mdns: { instance, host: serviceHost, port, txt: {} } }
}

describe('ESPHome mDNS discovery', () => {
  it('declares one mDNS browse for the esphomelib service', () => {
    expect(ESPHOME_DISCOVERY_MODES).toEqual([{ kind: 'mdns', serviceType: '_esphomelib._tcp' }])
  })

  it('reads a board out of an mDNS hit', () => {
    expect(
      boardsFromHits([
        boardHit('192.0.2.30', 'kitchen._esphomelib._tcp.local', 'Kitchen.local', 6054),
      ]),
    ).toEqual([{ host: '192.0.2.30', port: 6054, name: 'kitchen', id: 'kitchen' }])
  })

  it('collects each host once and skips a hit without an mDNS record', () => {
    const hit = boardHit('192.0.2.30', 'kitchen', 'kitchen.local', 6053)
    expect(
      boardsFromHits([hit, hit, { modeIndex: 0, host: '192.0.2.31', port: 6053 }]),
    ).toHaveLength(1)
  })

  it('turns a hit into a pickable candidate and skips a configured host', () => {
    const hit = boardHit('192.0.2.30', 'kitchen._esphomelib._tcp.local', 'kitchen.local', 6053)
    expect(boardCandidates([hit], [])).toEqual([
      {
        stableId: 'esphome:kitchen',
        type: DeviceType.Hub,
        suggestedName: 'kitchen',
        prefilledConfig: { host: '192.0.2.30', port: 6053 },
        selectable: true,
      },
    ])
    expect(boardCandidates([hit], ['192.0.2.30'])).toEqual([])
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
