/**
 * D1090 — the wiring between the cap methods and the autopilot. The autopilot's
 * own rules are in `adoption-autopilot.spec.ts`; these drive the REAL addon
 * through `adoptionRefresh`, `adoptionAdopt` and `adoptionRelease`, so a call
 * the cap method forgot to make shows up here.
 */
import type { DiscoveredChildDevice, ICapabilityRegistry, RecordsAccess } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { deviceManagerRecordKinds } from '../record-kinds.js'
import { setup } from './device-manager-harness.js'

const ADDON = 'provider-fuel'
const INTEGRATION = 'int_1'

interface AdoptedEntry {
  childNativeId: string
  parentDeviceId: number
  accessoryDeviceIds: number[]
}

class FuelSource {
  listed: string[] = []
  readonly adopted = new Map<string, number>()
  readonly adoptCalls: string[] = []
  listCalls = 0
  hangList = false
  declaredDefault: 'auto' | 'manual' | undefined = undefined
  private next = 200

  async refresh(): Promise<{
    lastDiscoveryAt: number
    candidateCount: number
    adoptedCount: number
    lastError: null
    defaultAdoptMode?: 'auto' | 'manual'
  }> {
    return {
      ...(this.declaredDefault !== undefined ? { defaultAdoptMode: this.declaredDefault } : {}),
      lastDiscoveryAt: 1,
      candidateCount: this.listed.length,
      adoptedCount: this.adopted.size,
      lastError: null,
    }
  }

  async listCandidates(): Promise<{ candidates: DiscoveredChildDevice[] }> {
    this.listCalls += 1
    if (this.hangList) await new Promise<never>(() => {})
    return {
      candidates: this.listed.map((id) => ({
        childNativeId: id,
        name: id,
        type: DeviceType.Sensor,
        status: 'online',
        metadata: {},
        alreadyAdopted: this.adopted.has(id),
        adoptedDeviceId: this.adopted.get(id) ?? null,
      })),
    }
  }

  async adopt(input: { childNativeIds: readonly string[] }): Promise<{ adopted: AdoptedEntry[] }> {
    const id = input.childNativeIds[0] ?? ''
    this.adoptCalls.push(id)
    const parentDeviceId = this.next++
    this.adopted.set(id, parentDeviceId)
    return { adopted: [{ childNativeId: id, parentDeviceId, accessoryDeviceIds: [] }] }
  }

  async release(input: { camDeviceId: number }): Promise<void> {
    for (const [id, deviceId] of this.adopted) {
      if (deviceId === input.camDeviceId) this.adopted.delete(id)
    }
  }
}

/** Only these three registry calls happen on this path; the double is asserted at that boundary. */
function registryServing(source: FuelSource): ICapabilityRegistry {
  const registry = {
    waitForProvider: async () => source,
    unregisterAllNativeForDevice: vi.fn(),
    setStatusOverlay: vi.fn(),
  }
  return registry as unknown as ICapabilityRegistry
}

interface Failing {
  tombstoneRead: boolean
  recordWrite: boolean
}

/** The real records, with one kind made to fail on demand. */
function failingRecords(base: RecordsAccess, failing: Failing): RecordsAccess {
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop !== 'kind') return Reflect.get(target, prop, receiver)
      return (definition: Parameters<RecordsAccess['kind']>[0]) => {
        const handle = target.kind(definition)
        return new Proxy(handle, {
          get: (h, p) => {
            if (
              definition === deviceManagerRecordKinds.tombstones &&
              p === 'query' &&
              failing.tombstoneRead
            ) {
              return async () => {
                throw new Error('tombstones unreadable')
              }
            }
            if (
              definition === deviceManagerRecordKinds['adoption-records'] &&
              p === 'put' &&
              failing.recordWrite
            ) {
              return async () => {
                throw new Error('adoption records unwritable')
              }
            }
            return Reflect.get(h, p)
          },
        })
      }
    },
  })
}

async function world(): Promise<{
  h: Awaited<ReturnType<typeof setup>>
  source: FuelSource
  failing: Failing
  settle: () => Promise<void>
}> {
  const source = new FuelSource()
  const failing: Failing = { tombstoneRead: false, recordWrite: false }
  const h = await setup({
    capabilityRegistry: registryServing(source),
    wrapRecords: (base) => failingRecords(base, failing),
  })
  const settle = async (): Promise<void> => {
    // The post-refresh pass is detached from the refresh call: wait for the
    // pass's own "finished" line, then for its jobs.
    await expect
      .poll(() =>
        vi.mocked(h.logger.debug).mock.calls.some(([m]) => m === 'adoption: pass finished'),
      )
      .toBe(true)
    await expect
      .poll(async () =>
        (await h.provider.adoptionListJobs({ addonId: ADDON })).some((j) => j.state === 'running'),
      )
      .toBe(false)
  }
  return { h, source, failing, settle }
}

const ids = { addonId: ADDON, integrationId: INTEGRATION }

describe('adoptionRefresh runs the autopilot (D1090)', () => {
  it('auto-adopts a candidate after the refresh of an auto instance', async () => {
    const { h, source, settle } = await world()
    await h.provider.adoptionSetMode({ ...ids, adoptMode: 'auto' })
    source.listed = ['st-1']
    await h.provider.adoptionRefresh(ids)
    await expect.poll(() => source.adoptCalls).toEqual(['st-1'])
    await settle()
    const records = await h.provider.adoptionListRecords(ids)
    expect(records.map((r) => [r.childNativeId, r.adoptedBy])).toEqual([['st-1', 'auto']])
  })

  it('skips a manual instance with no records without listing candidates', async () => {
    const { h, source, settle } = await world()
    source.listed = ['st-1']
    await h.provider.adoptionRefresh(ids)
    await settle()
    expect(source.listCalls).toBe(0)
    expect(source.adoptCalls).toEqual([])
  })

  it('changes nothing when the tombstones cannot be read (D49)', async () => {
    const { h, source, failing, settle } = await world()
    await h.provider.adoptionSetMode({ ...ids, adoptMode: 'auto' })
    source.listed = ['st-1']
    failing.tombstoneRead = true
    await h.provider.adoptionRefresh(ids)
    await settle()
    expect(source.adoptCalls).toEqual([])
    expect(await h.provider.adoptionListRecords(ids)).toEqual([])
  })
})

describe('the refresh does not wait for the autopilot, and getMode agrees with it (D1090)', () => {
  it('returns although the candidate listing never answers', async () => {
    const { h, source } = await world()
    await h.provider.adoptionSetMode({ ...ids, adoptMode: 'auto' })
    source.hangList = true
    const status = await h.provider.adoptionRefresh(ids)
    expect(status.lastError).toBeNull()
  })

  it('answers manual in a fresh process, until the instance refreshed', async () => {
    const { h, source } = await world()
    source.declaredDefault = 'auto'
    expect(await h.provider.adoptionGetMode(ids)).toEqual({ adoptMode: 'manual', stored: false })
  })

  it('reports the provider default when nothing is stored, as the refresh applies it', async () => {
    const { h, source, settle } = await world()
    source.declaredDefault = 'auto'
    source.listed = ['st-1']
    await h.provider.adoptionRefresh(ids)
    await expect.poll(() => source.adoptCalls).toEqual(['st-1'])
    await settle()
    expect(await h.provider.adoptionGetMode(ids)).toEqual({ adoptMode: 'auto', stored: false })
  })
})

describe('two quick refreshes (D1090)', () => {
  it('start one adopt job, not two', async () => {
    const { h, source, settle } = await world()
    await h.provider.adoptionSetMode({ ...ids, adoptMode: 'auto' })
    source.listed = ['st-1']
    await Promise.all([h.provider.adoptionRefresh(ids), h.provider.adoptionRefresh(ids)])
    await settle()
    expect(source.adoptCalls).toEqual(['st-1'])
  })
})

describe('adoptionRelease records the release (D1090)', () => {
  it('keeps a released candidate from coming back through auto', async () => {
    const { h, source, settle } = await world()
    await h.provider.adoptionSetMode({ ...ids, adoptMode: 'auto' })
    source.listed = ['st-1']
    await h.provider.adoptionRefresh(ids)
    await expect.poll(() => source.adopted.has('st-1')).toBe(true)
    await settle()
    const deviceId = source.adopted.get('st-1')
    if (deviceId === undefined) throw new Error('st-1 was not adopted')

    await h.provider.adoptionRelease({ ...ids, camDeviceId: deviceId })
    const released = await h.provider.adoptionListRecords(ids)
    expect(released.map((r) => r.released)).toEqual([true])

    await h.provider.adoptionRefresh(ids)
    await settle()
    expect(source.adoptCalls).toEqual(['st-1'])
  })
})

describe('a ledger write that fails does not fail the operator (D1090)', () => {
  it('adoptionAdopt still answers what the provider adopted', async () => {
    const { h, source, failing } = await world()
    failing.recordWrite = true
    const result = await h.provider.adoptionAdopt({ ...ids, childNativeIds: ['st-1'] })
    expect(result.adopted.map((a) => a.childNativeId)).toEqual(['st-1'])
    expect(source.adopted.has('st-1')).toBe(true)
  })

  it('adoptionRelease still releases', async () => {
    const { h, source, failing } = await world()
    const adopted = await h.provider.adoptionAdopt({ ...ids, childNativeIds: ['st-1'] })
    const deviceId = adopted.adopted[0]?.parentDeviceId
    if (deviceId === undefined) throw new Error('st-1 was not adopted')
    failing.recordWrite = true
    await expect(h.provider.adoptionRelease({ ...ids, camDeviceId: deviceId })).resolves.toBe(
      undefined,
    )
    expect(source.adopted.has('st-1')).toBe(false)
  })
})
