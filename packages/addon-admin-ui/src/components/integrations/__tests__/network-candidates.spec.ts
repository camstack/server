import { describe, expect, it } from 'vitest'
import { mergeNetworkCandidates, type ScanHit } from '../network-candidates'

const NONE = new Set<string>()

function hit(stableId: string, host: string, extra: Partial<ScanHit> = {}): ScanHit {
  return {
    stableId,
    suggestedName: stableId,
    prefilledConfig: { host },
    ...extra,
  }
}

describe('mergeNetworkCandidates', () => {
  it('shows one row for a device seen by the scan and by a proposal', () => {
    const rows = mergeNetworkCandidates({
      adoption: [],
      scan: [hit('esp-attic', '192.0.2.10')],
      proposals: [{ id: 'p1', candidate: hit('esp-attic', '192.0.2.10') }],
      existingStableIds: NONE,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sources).toEqual(['scan', 'proposal'])
    expect(rows[0]?.proposalId).toBe('p1')
  })

  it('treats the same host under two ids as the same device', () => {
    const rows = mergeNetworkCandidates({
      adoption: [],
      scan: [hit('host-192.0.2.10', '192.0.2.10')],
      proposals: [{ id: 'p1', candidate: hit('mdns-attic', '192.0.2.10') }],
      existingStableIds: NONE,
    })
    expect(rows).toHaveLength(1)
  })

  it('merges an adoption entry with the scan hit that names it by the same id', () => {
    const rows = mergeNetworkCandidates({
      adoption: [{ childNativeId: 'esp-attic', name: 'attic' }],
      scan: [hit('esp-attic', '192.0.2.10')],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sources).toEqual(['adoption', 'scan'])
    expect(rows[0]?.hit?.stableId).toBe('esp-attic')
    expect(rows[0]?.adoptionId).toBe('esp-attic')
  })

  it('keeps two different devices apart', () => {
    const rows = mergeNetworkCandidates({
      adoption: [],
      scan: [hit('a', '192.0.2.10'), hit('b', '192.0.2.11')],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows.map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('flags a device that already exists, by any of the three verdicts', () => {
    const rows = mergeNetworkCandidates({
      adoption: [{ childNativeId: 'c', name: 'c', alreadyAdopted: true }],
      scan: [
        hit('a', '192.0.2.10'),
        hit('b', '192.0.2.11', {
          alreadyOnboarded: true,
          onboardedName: 'Garage',
        }),
      ],
      proposals: [],
      existingStableIds: new Set(['a']),
    })
    expect(rows.map((r) => r.alreadyAdded)).toEqual([true, true, true])
    expect(rows[2]?.addedName).toBe('Garage')
  })

  it('carries the parameters a candidate still needs, and only that candidate', () => {
    const rows = mergeNetworkCandidates({
      adoption: [],
      scan: [
        hit('enc', '192.0.2.10', { needsParams: ['encryptionKey'] }),
        hit('plain', '192.0.2.11'),
      ],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows.map((r) => r.needsParams)).toEqual([['encryptionKey'], []])
  })

  it('nests a device under the gateway it was found behind', () => {
    const rows = mergeNetworkCandidates({
      adoption: [],
      scan: [hit('gw', '192.0.2.2'), hit('child', '192.0.2.3', { parentStableId: 'gw' })],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows[1]?.parentKey).toBe('gw')
    expect(rows[0]?.parentKey).toBeNull()
  })

  it('carries the hub device an adopted row is, from the provider or from the hub list', () => {
    const rows = mergeNetworkCandidates({
      adoption: [
        {
          childNativeId: 'a',
          name: 'a',
          alreadyAdopted: true,
          adoptedDeviceId: 11,
        },
        {
          childNativeId: 'n',
          name: 'n',
          alreadyAdopted: false,
          adoptedDeviceId: null,
        },
      ],
      scan: [hit('held', '192.0.2.50')],
      proposals: [],
      existingStableIds: new Set(['held']),
      existingDeviceIds: new Map([['held', 22]]),
    })
    const byKey = new Map(rows.map((r) => [r.key, r]))
    expect(byKey.get('a')?.deviceId).toBe(11)
    expect(byKey.get('n')?.deviceId).toBeNull()
    expect(byKey.get('held')?.deviceId).toBe(22)
  })
  it('merges adopted boards with the scan hits that name them differently, by the MAC both carry', () => {
    // Live shapes: the adoption side keys on the broker id, the scan on `esphome:<mDNS name>`.
    const adopted = [
      {
        childNativeId: 'esp_3aa912f8',
        name: 'switch-luci-veranda-2',
        mac: 'AA:BB:CC:3A:A9:12',
        alreadyAdopted: true,
        adoptedDeviceId: 5978,
      },
      {
        childNativeId: 'esp_1b1b1213',
        name: 'switch-luci-veranda-1',
        mac: 'AA:BB:CC:1B:1B:12',
        alreadyAdopted: true,
        adoptedDeviceId: 5969,
      },
      {
        childNativeId: 'ir-transmitter-salone',
        name: 'ir-transmitter-salone',
        mac: 'AA:BB:CC:00:00:51',
        alreadyAdopted: true,
        adoptedDeviceId: 5394,
      },
    ]
    const found = (name: string, ip: string, mac: string): ScanHit =>
      hit(`esphome:${name}`, ip, { sourceInfo: { uniqueId: mac } })
    const rows = mergeNetworkCandidates({
      adoption: adopted,
      scan: [
        found('switch-luci-veranda-2', '192.0.2.62', 'aabbcc3aa912'),
        found('switch-luci-veranda-1', '192.0.2.61', 'aabbcc1b1b12'),
        found('ir-transmitter-salone', '192.0.2.63', 'aabbcc000051'),
      ],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.sources.join() === 'adoption,scan' && r.alreadyAdded)).toBe(true)
    expect(rows.find((r) => r.adoptionId === 'esp_3aa912f8')?.deviceId).toBe(5978)
  })

  it('never merges on a value that is not a MAC', () => {
    const rows = mergeNetworkCandidates({
      adoption: [{ childNativeId: 'a', name: 'a', mac: 'not-a-mac' }],
      scan: [hit('b', '192.0.2.1', { sourceInfo: { uniqueId: 'not-a-mac' } })],
      proposals: [],
      existingStableIds: NONE,
    })
    expect(rows).toHaveLength(2)
  })
})
