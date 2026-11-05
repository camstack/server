import { describe, expect, it } from 'vitest'
import { mergeNetworkCandidates, type ScanHit } from '../network-candidates'

const NONE = new Set<string>()

function hit(stableId: string, host: string, extra: Partial<ScanHit> = {}): ScanHit {
  return { stableId, suggestedName: stableId, prefilledConfig: { host }, ...extra }
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
        hit('b', '192.0.2.11', { alreadyOnboarded: true, onboardedName: 'Garage' }),
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
})
