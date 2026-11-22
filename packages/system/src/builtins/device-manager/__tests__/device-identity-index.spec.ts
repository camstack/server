/**
 * The identifier index (planning#593): which devices of DIFFERENT integrations
 * share provider-declared identifiers, and how sure the match is.
 *
 * The index is a projection of the device rows, so these specs drive it through
 * the REAL `DeviceRowStore` (on the real SQLite settings backend) with the index
 * as its observer: a row write, a patch, a swap and a delete are what move it,
 * never a scan per question.
 */

import type {
  DeviceIdentifierKey,
  DeviceIdentifiers,
  IScopedLogger,
  RawDeviceIdentifiers,
} from '@camstack/types'
import { IdentityCandidatesSchema, normaliseIdentifiers } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { DeviceIdentityIndex } from '../device-identity-index.js'
import { DeviceRowStore, deviceRowBackendOf } from '../device-row-store.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function ids(raw: RawDeviceIdentifiers): DeviceIdentifiers {
  return normaliseIdentifiers(raw, { readAt: 1_000 }).identifiers
}

const MAC = 'AA:BB:CC:00:11:22'
const SERIAL = { manufacturer: 'Hikvision', serial: 'DS-123' }

interface Fixture {
  readonly id: number
  readonly addonId: string
  readonly integrationId?: string
  readonly identifiers?: DeviceIdentifiers
  readonly attachedIdentifiers?: DeviceIdentifiers
  /** The attached keys the provider last declared unread: kept, not seen now. */
  readonly attachedRetained?: readonly DeviceIdentifierKey[]
  readonly role?: string
}

async function makeIndexed(fixtures: readonly Fixture[]): Promise<{
  readonly index: DeviceIdentityIndex
  readonly rows: DeviceRowStore
}> {
  const api = await makeSettingsStoreApi()
  const index = new DeviceIdentityIndex()
  const rows = new DeviceRowStore(deviceRowBackendOf(api.api), makeLogger(), undefined, index)
  for (const f of fixtures) {
    await rows.upsert(
      {
        id: f.id,
        addonId: f.addonId,
        stableId: `s-${f.id}`,
        type: 'camera',
        name: `Device ${f.id}`,
        location: null,
        disabled: false,
        parentDeviceId: null,
        ...(f.integrationId !== undefined ? { integrationId: f.integrationId } : {}),
        ...(f.identifiers !== undefined ? { identifiers: f.identifiers } : {}),
        ...(f.attachedIdentifiers !== undefined
          ? { attachedIdentifiers: f.attachedIdentifiers }
          : {}),
        ...(f.attachedRetained !== undefined ? { attachedRetained: f.attachedRetained } : {}),
        ...(f.role !== undefined ? { role: f.role } : {}),
      },
      { registered: true },
    )
  }
  index.seed(await rows.listAll())
  return { index, rows }
}

function answered(index: DeviceIdentityIndex) {
  const result = index.candidates()
  if (result.status !== 'answered') throw new Error(`index not answered: ${result.reason}`)
  return result
}

describe('DeviceIdentityIndex — the pair rules', () => {
  it('two strong kinds across two integrations → auto, with every shared key', async () => {
    const { index } = await makeIndexed([
      {
        id: 1,
        addonId: 'provider-hikvision',
        integrationId: 'int_1',
        identifiers: ids({ mac: MAC, serial: SERIAL, ip: '192.0.2.10' }),
      },
      {
        id: 2,
        addonId: 'provider-onvif',
        integrationId: 'int_2',
        identifiers: ids({ mac: MAC, serial: SERIAL }),
      },
    ])

    const { pairs } = answered(index)
    expect(pairs).toEqual([
      {
        a: { deviceId: 1, addonId: 'provider-hikvision', integrationId: 'int_1' },
        b: { deviceId: 2, addonId: 'provider-onvif', integrationId: 'int_2' },
        keys: [
          { key: 'mac', value: 'aa:bb:cc:00:11:22' },
          { key: 'serial', value: 'hikvision:ds-123' },
        ],
        confidence: 'auto',
      },
    ])
  })

  it('MAC plus a matching IP → auto', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC, ip: '192.0.2.10' }) },
      { id: 2, addonId: 'b', identifiers: ids({ mac: MAC, ip: '192.0.2.10' }) },
    ])
    const { pairs } = answered(index)
    expect(pairs.map((p) => p.confidence)).toEqual(['auto'])
    expect(pairs[0]?.keys.map((k) => k.key)).toEqual(['ip', 'mac'])
  })

  it('exactly one strong kind → proposal (two MACs of one kind are still one kind)', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: [MAC, '00:11:22:33:44:55'] }) },
      { id: 2, addonId: 'b', identifiers: ids({ mac: [MAC, '00:11:22:33:44:55'] }) },
      { id: 3, addonId: 'c', identifiers: ids({ vendorUid: { vendor: 'reolink', id: 'UID9' } }) },
      { id: 4, addonId: 'd', identifiers: ids({ vendorUid: { vendor: 'reolink', id: 'uid9' } }) },
    ])
    const { pairs } = answered(index)
    expect(pairs.map((p) => [p.a.deviceId, p.b.deviceId, p.confidence])).toEqual([
      [1, 2, 'proposal'],
      [3, 4, 'proposal'],
    ])
  })

  it('weak keys alone never match', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ hostname: 'cam-1', ip: '192.0.2.10' }) },
      { id: 2, addonId: 'b', identifiers: ids({ hostname: 'cam-1.lan', ip: '192.0.2.10' }) },
    ])
    expect(answered(index).pairs).toEqual([])
  })

  it('a match inside one integration is no candidate', async () => {
    const { index } = await makeIndexed([
      // Same integration instance.
      { id: 1, addonId: 'a', integrationId: 'int_1', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'a', integrationId: 'int_1', identifiers: ids({ mac: MAC }) },
      // Same addon, no instance stamped on one side: in doubt, the same integration.
      { id: 3, addonId: 'b', identifiers: ids({ serial: SERIAL }) },
      { id: 4, addonId: 'b', integrationId: 'int_7', identifiers: ids({ serial: SERIAL }) },
    ])
    expect(answered(index).pairs).toEqual([])
  })

  it('two instances of the SAME addon are two integrations', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', integrationId: 'int_1', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'a', integrationId: 'int_2', identifiers: ids({ mac: MAC }) },
    ])
    expect(answered(index).pairs.map((p) => p.confidence)).toEqual(['proposal'])
  })
})

describe('DeviceIdentityIndex — unknown is never "no match"', () => {
  it('answers unknown, not an empty list, before it is seeded', () => {
    const index = new DeviceIdentityIndex()
    expect(index.candidates().status).toBe('unknown')
  })

  it('both answers are the shape the cap declares (the router does not re-validate output)', async () => {
    expect(IdentityCandidatesSchema.safeParse(new DeviceIdentityIndex().candidates()).success).toBe(
      true,
    )
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC, ip: '192.0.2.10' }) },
      { id: 2, addonId: 'b', identifiers: ids({ mac: MAC, ip: '192.0.2.10' }) },
      { id: 3, addonId: 'c' },
    ])
    expect(IdentityCandidatesSchema.safeParse(index.candidates()).success).toBe(true)
  })

  it('lists the devices with no identifiers on record as undeclared', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'b' },
    ])
    expect(answered(index).undeclaredDeviceIds).toEqual([2])
  })
})

describe('DeviceIdentityIndex — maintained from the row writes', () => {
  it('a declaration patched on a row creates the pair; clearing it drops the pair', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'b' },
    ])
    expect(answered(index).pairs).toEqual([])

    await rows.patch(2, { identifiers: ids({ mac: MAC }) })
    expect(answered(index).pairs.map((p) => [p.a.deviceId, p.b.deviceId])).toEqual([[1, 2]])
    expect(answered(index).undeclaredDeviceIds).toEqual([])

    await rows.patch(2, { identifiers: null })
    expect(answered(index).pairs).toEqual([])
    expect(answered(index).undeclaredDeviceIds).toEqual([2])
  })

  it('stamping an integration moves the pair in or out', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'a', integrationId: 'int_1', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'a', integrationId: 'int_1', identifiers: ids({ mac: MAC }) },
    ])
    expect(answered(index).pairs).toEqual([])
    await rows.patch(2, { integrationId: 'int_2' })
    expect(answered(index).pairs).toHaveLength(1)
  })

  it('removing a device drops it from the index', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'b', identifiers: ids({ mac: MAC }) },
      { id: 3, addonId: 'c' },
    ])
    expect(answered(index).pairs).toHaveLength(1)

    await rows.remove(2)
    await rows.remove(3)
    expect(answered(index).pairs).toEqual([])
    expect(answered(index).undeclaredDeviceIds).toEqual([])
  })

  it('a registration of a new device enters it as undeclared', async () => {
    const { index, rows } = await makeIndexed([])
    await rows.upsertRegistration({
      deviceId: 9,
      addonId: 'a',
      stableId: 's-9',
      type: 'camera',
      name: 'New',
      userNamed: false,
      location: null,
      disabled: false,
      parentDeviceId: null,
      registered: true,
      features: [],
      exportFingerprint: 'fp',
    })
    expect(answered(index).undeclaredDeviceIds).toEqual([9])
  })

  it('a swap of ids carries each declaration to its new number', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'a', identifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'b' },
      { id: 3, addonId: 'c', identifiers: ids({ mac: MAC }) },
    ])
    await rows.swapIds(1, 2, 99)
    const result = answered(index)
    expect(result.pairs.map((p) => [p.a.deviceId, p.b.deviceId])).toEqual([[2, 3]])
    expect(result.undeclaredDeviceIds).toEqual([1])
  })

  it('a write that lands while the seed is being read is not lost', async () => {
    const api = await makeSettingsStoreApi()
    const index = new DeviceIdentityIndex()
    const rows = new DeviceRowStore(deviceRowBackendOf(api.api), makeLogger(), undefined, index)
    const base = {
      stableId: 's',
      type: 'camera',
      name: 'd',
      location: null,
      disabled: false,
      parentDeviceId: null,
    }
    await rows.upsert({ ...base, id: 1, addonId: 'a', identifiers: ids({ mac: MAC }) })
    await rows.upsert({ ...base, id: 2, addonId: 'b' })
    const snapshot = await rows.listAll()
    // Lands after the snapshot was read, before it is applied.
    await rows.patch(2, { identifiers: ids({ mac: MAC }) })
    index.seed(snapshot)
    expect(answered(index).pairs).toHaveLength(1)
  })
})

describe('DeviceIdentityIndex — what a device declares ATTACHED to it (D1063)', () => {
  const IP = '10.0.0.7'

  function attached(index: DeviceIdentityIndex): readonly (readonly [number, number, string])[] {
    const answer = index.linkCandidates()
    if (answer.status !== 'answered') throw new Error('expected answered')
    return answer.candidates
      .filter((c) => c.kind === 'poe-power')
      .map((c) => [c.a.deviceId, c.b.deviceId, c.confidence] as const)
  }

  it("a port whose client MAC and IP are a camera's is an auto poe-power candidate, port first", async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    expect(attached(index)).toEqual([[1, 2, 'auto']])
    const answer = index.linkCandidates()
    const first = answer.status === 'answered' ? answer.candidates[0] : undefined
    expect(first?.aRole).toBe('poe-port')
    expect(first?.a.stableId).toBe('s-1')
  })

  it('one strong kind alone is a proposal; an attached declaration never matches its own integration', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC }) },
      { id: 3, addonId: 'unifi', identifiers: ids({ mac: MAC }) },
    ])
    expect(attached(index)).toEqual([[1, 2, 'proposal']])
  })

  it('two ports reaching one camera are each only a proposal', async () => {
    const { index } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 4, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    expect(attached(index)).toEqual([
      [1, 2, 'proposal'],
      [4, 2, 'proposal'],
    ])
  })

  it('a splitter port reaching two cameras links both, auto, in a stable order whatever the declaration order', async () => {
    const MAC2 = 'AA:BB:CC:00:11:33'
    const world = (order: readonly string[]) =>
      makeIndexed([
        { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: order }) },
        { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC }) },
        { id: 3, addonId: 'hik', identifiers: ids({ mac: MAC2 }) },
      ])
    const first = await world([MAC, MAC2])
    const second = await world([MAC2, MAC])
    const expected = [
      [1, 2, 'auto'],
      [1, 3, 'auto'],
    ]
    expect(attached(first.index)).toEqual(expected)
    expect(attached(second.index)).toEqual(expected)
  })

  it('a port with several MACs and one fresh client IP still needs the IP to corroborate (MAC-only auto is for a splitter)', async () => {
    const MAC2 = 'AA:BB:CC:00:11:33'
    const { index } = await makeIndexed([
      {
        id: 1,
        addonId: 'unifi',
        role: 'poe-port',
        attachedIdentifiers: ids({ mac: [MAC, MAC2], ip: IP }),
      },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC }) },
    ])
    expect(attached(index)).toEqual([[1, 2, 'proposal']])
  })

  it('a client the port retains while another is present keeps its candidate; one freshly on another port moves', async () => {
    const MAC2 = 'AA:BB:CC:00:11:33'
    const { index } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: [MAC, MAC2] }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC }) },
      { id: 3, addonId: 'hik', identifiers: ids({ mac: MAC2 }) },
    ])
    expect(attached(index)).toHaveLength(2)
    const moved = await makeIndexed([
      {
        id: 1,
        addonId: 'unifi',
        role: 'poe-port',
        attachedIdentifiers: ids({ mac: [MAC, MAC2] }),
        attachedRetained: ['mac'],
      },
      {
        id: 4,
        addonId: 'unifi',
        role: 'poe-port',
        attachedIdentifiers: ids({ mac: MAC2, ip: IP }),
      },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC }) },
      { id: 3, addonId: 'hik', identifiers: ids({ mac: MAC2, ip: IP }) },
    ])
    expect(attached(moved.index)).toEqual([
      [1, 2, 'auto'],
      [4, 3, 'auto'],
    ])
  })

  it('a port that FRESHLY reports the MAC another port only retains takes the camera; the retained pair is no candidate', async () => {
    const { index } = await makeIndexed([
      {
        id: 1,
        addonId: 'unifi',
        role: 'poe-port',
        attachedIdentifiers: ids({ mac: MAC, ip: IP }),
        attachedRetained: ['ip', 'mac'],
      },
      { id: 4, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    expect(attached(index)).toEqual([[4, 2, 'auto']])
  })

  it('a port that only retains its MAC, with no fresh rival, keeps its candidate (D49)', async () => {
    const { index } = await makeIndexed([
      {
        id: 1,
        addonId: 'unifi',
        role: 'poe-port',
        attachedIdentifiers: ids({ mac: MAC, ip: IP }),
        attachedRetained: ['ip', 'mac'],
      },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    expect(attached(index)).toEqual([[1, 2, 'auto']])
  })

  it('patching the retained keys moves the candidate', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 4, addonId: 'unifi', role: 'poe-port', attachedIdentifiers: ids({ mac: MAC, ip: IP }) },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    await rows.patch(1, { attachedRetained: ['ip', 'mac'] })
    expect(attached(index)).toEqual([[4, 2, 'auto']])
  })

  it('patching an attached declaration notifies the listener and moves the candidate', async () => {
    const { index, rows } = await makeIndexed([
      { id: 1, addonId: 'unifi', role: 'poe-port' },
      { id: 2, addonId: 'hik', identifiers: ids({ mac: MAC, ip: IP }) },
    ])
    const changed = vi.fn()
    index.onIdentityChanged(changed)
    expect(attached(index)).toEqual([])
    await rows.patch(1, { attachedIdentifiers: ids({ mac: MAC, ip: IP }) })
    expect(changed).toHaveBeenCalled()
    expect(attached(index)).toEqual([[1, 2, 'auto']])
  })

  it('answers unknown before the seed', () => {
    expect(new DeviceIdentityIndex().linkCandidates()).toEqual({ status: 'unknown' })
  })
})
