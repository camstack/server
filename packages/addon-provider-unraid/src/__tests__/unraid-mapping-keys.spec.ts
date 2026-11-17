import { describe, expect, it } from 'vitest'
import type { UnraidArrayDiskInfo, UnraidSnapshot } from '../unraid-client-contract.js'
import { buildEntityIdentities } from '../unraid-mapping.js'

/**
 * Unraid API ids are PrefixedIDs `<64-hex server hash>:<local id>`: every disk (and
 * container, and VM) of one server shares the same prefix. A key cut from the front of the
 * full id collapsed them all onto the server hash, and the entity list kept one of each.
 */
const SERVER = '4b0175070bd2bdbc14112e80333b73341203a1e3197cc6c8a1b2c3d4e5f60718'

const disk = (local: string, name: string): UnraidArrayDiskInfo => ({
  id: `${SERVER}:${local}`,
  name,
  fsSizeBytes: 1000,
  fsUsedBytes: 400,
  fsFreeBytes: 600,
  tempC: 30,
  healthy: true,
})

function snapshot(disks: readonly UnraidArrayDiskInfo[]): UnraidSnapshot {
  return {
    array: {
      state: 'STARTED',
      capacityKb: { total: 1000, used: 400, free: 600 },
      parityCheck: null,
      disks,
    },
    cpu: { percent: 12, tempC: null, powerW: null },
    disks,
    dockers: [],
    vms: [],
    notifications: { activeCount: 0, latest: null },
  }
}

describe('Unraid entity keys', () => {
  it('three disks sharing the server prefix yield three distinct entities', () => {
    const keys = buildEntityIdentities(
      snapshot([
        disk('WDC_WD80EFAX-68KNBN0_VAGW1111', 'disk1'),
        disk('WDC_WD80EFAX-68KNBN0_VAGW2222', 'disk2'),
        disk('Samsung_SSD_870_EVO_1TB_S6PU3333', 'cache'),
      ]),
    ).map((identity) => identity.key)

    expect(new Set(keys.filter((k) => /^disk_.*_usage$/.test(k))).size).toBe(3)
    // No key carries the shared server hash.
    expect(keys.some((k) => k.includes(SERVER.slice(0, 16)))).toBe(false)
  })

  it('every key of a snapshot is unique, even for ids that slugify alike or truncate alike', () => {
    const long = 'x'.repeat(80)
    const identities = buildEntityIdentities(
      snapshot([
        disk('Disk_1', 'disk1'),
        disk('disk-1', 'disk1b'),
        disk(`${long}A`, 'a'),
        disk(`${long}B`, 'b'),
      ]),
    )
    const keys = identities.map((identity) => identity.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => k.length <= 80 && /^[a-z0-9_-]+$/.test(k))).toBe(true)
  })

  it('a key is stable across polls and does not depend on the order of the list', () => {
    const a = disk(`${'y'.repeat(60)}1`, 'disk1')
    const b = disk(`${'y'.repeat(60)}2`, 'disk2')
    const first = buildEntityIdentities(snapshot([a, b])).map((i) => i.key)
    const second = buildEntityIdentities(snapshot([b, a])).map((i) => i.key)
    expect([...second].sort()).toEqual([...first].sort())
  })
})
