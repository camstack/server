/**
 * D1090 — the adopt mode and the `withdrawn` state live in the device manager,
 * not in a provider. These specs drive the REAL job engine with a fake source.
 */
import {
  DeviceType,
  ADOPTION_MISS_MIN_SPACING_MS,
  type AdoptionRecord,
  type AdoptMode,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IScopedLogger,
} from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { AdoptionAutopilot, type AutopilotProvider } from '../adoption-autopilot.js'
import {
  AdoptionJobEngine,
  type AdoptionJobProvider,
  type AdoptResult,
} from '../adoption-job-engine.js'
import { type AdoptionLedger, recordKey } from '../adoption-ledger.js'

const ADDON = 'addon-fuel-prices'
const INTEGRATION = 'int_1'

function makeLogger(): IScopedLogger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
  }
  return l as unknown as IScopedLogger
}

class MemoryLedger implements AdoptionLedger {
  readonly modes = new Map<string, AdoptMode>()
  readonly records = new Map<string, AdoptionRecord>()
  async getMode(addonId: string, integrationId: string): Promise<AdoptMode | null> {
    return this.modes.get(`${addonId}::${integrationId}`) ?? null
  }
  async setMode(addonId: string, integrationId: string, adoptMode: AdoptMode): Promise<void> {
    this.modes.set(`${addonId}::${integrationId}`, adoptMode)
  }
  async listRecords(addonId: string, integrationId?: string): Promise<readonly AdoptionRecord[]> {
    return [...this.records.values()].filter(
      (r) =>
        r.addonId === addonId && (integrationId === undefined || r.integrationId === integrationId),
    )
  }
  async putRecord(record: AdoptionRecord): Promise<void> {
    this.records.set(recordKey(record), record)
  }
}

/** A source of stations: `listed` is what it offers now, `adopted` what became devices. */
class FakeSource implements AdoptionJobProvider, AutopilotProvider {
  listed: string[] = []
  readonly adopted = new Map<string, number>()
  readonly adoptCalls: string[] = []
  readonly released: number[] = []
  failList = false
  /** While set, `listCandidates` waits for it: a slow source. */
  gate: Promise<void> | null = null
  private nextDevice = 100

  private candidate(id: string): DiscoveredChildDevice {
    const deviceId = this.adopted.get(id)
    return {
      childNativeId: id,
      name: id,
      type: DeviceType.Sensor,
      status: 'online',
      metadata: {},
      alreadyAdopted: deviceId !== undefined,
      adoptedDeviceId: deviceId ?? null,
    }
  }

  async listCandidates(): Promise<{
    readonly candidates: readonly DiscoveredChildDevice[]
  }> {
    if (this.gate !== null) await this.gate
    if (this.failList) throw new Error('source unreachable')
    return { candidates: this.listed.map((id) => this.candidate(id)) }
  }

  async adopt(input: { childNativeIds: readonly string[] }): Promise<AdoptResult> {
    const id = input.childNativeIds[0] ?? ''
    this.adoptCalls.push(id)
    const parentDeviceId = this.nextDevice++
    this.adopted.set(id, parentDeviceId)
    return {
      adopted: [{ childNativeId: id, parentDeviceId, accessoryDeviceIds: [] }],
    }
  }
}

function setup(): {
  source: FakeSource
  ledger: MemoryLedger
  tombstones: Map<number, number>
  tombstoneFails: { value: boolean }
  autopilot: AdoptionAutopilot
  engine: AdoptionJobEngine
  clock: { t: number }
  /** One discovery; `advanceMs` is the time since the last one (default: past the miss spacing). */
  refresh: (status?: Partial<AdoptionStatus>, advanceMs?: number) => Promise<void>
} {
  const source = new FakeSource()
  const ledger = new MemoryLedger()
  const tombstones = new Map<number, number>()
  const tombstoneFails = { value: false }
  const clock = { t: 1_000 }
  const logger = makeLogger()
  const holder: { autopilot: AdoptionAutopilot | null } = { autopilot: null }
  const engine = new AdoptionJobEngine({
    resolveProvider: async () => source,
    logger,
    now: () => clock.t,
    onAdopted: async (a) => {
      await holder.autopilot?.recordAdopted(a)
    },
  })
  const autopilot = new AdoptionAutopilot({
    ledger,
    jobs: engine,
    resolveProvider: async () => source,
    tombstones: async () => {
      if (tombstoneFails.value) throw new Error('records unreadable')
      return tombstones
    },
    logger,
    now: () => clock.t,
  })
  holder.autopilot = autopilot
  const refresh = async (
    status?: Partial<AdoptionStatus>,
    advanceMs: number = ADOPTION_MISS_MIN_SPACING_MS + 1_000,
  ): Promise<void> => {
    clock.t += advanceMs
    await autopilot.afterRefresh({
      addonId: ADDON,
      integrationId: INTEGRATION,
      status: {
        lastDiscoveryAt: clock.t,
        candidateCount: source.listed.length,
        adoptedCount: source.adopted.size,
        lastError: null,
        ...status,
      },
    })
    for (const job of engine.list({ addonId: ADDON })) await engine.waitForTest(job.jobId)
  }
  return { source, ledger, tombstones, tombstoneFails, autopilot, engine, clock, refresh }
}

describe('auto adopt (D1090)', () => {
  it('adopts a new candidate through the job engine and records `auto`', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1', 'st-2']
    await t.refresh()
    expect(t.source.adoptCalls).toEqual(['st-1', 'st-2'])
    expect(t.engine.list({ addonId: ADDON })).toHaveLength(1)
    const records = await t.autopilot.listRecords(ADDON, INTEGRATION)
    expect(records.map((r) => [r.childNativeId, r.adoptedBy, r.adoptionState])).toEqual([
      ['st-1', 'auto', 'offered'],
      ['st-2', 'auto', 'offered'],
    ])
  })

  it('adopts nothing in manual mode, which is the default', async () => {
    const t = setup()
    t.source.listed = ['st-1']
    await t.refresh()
    expect(t.source.adoptCalls).toEqual([])
    expect(await t.autopilot.effectiveMode(ADDON, INTEGRATION)).toEqual({
      adoptMode: 'manual',
      stored: false,
    })
  })

  it('takes the default a provider declares, until the operator stores a mode', async () => {
    const t = setup()
    t.source.listed = ['st-1']
    await t.refresh({ defaultAdoptMode: 'auto' })
    expect(t.source.adoptCalls).toEqual(['st-1'])
    await t.autopilot.setMode(ADDON, INTEGRATION, 'manual')
    t.source.listed = ['st-1', 'st-2']
    await t.refresh({ defaultAdoptMode: 'auto' })
    expect(t.source.adoptCalls).toEqual(['st-1'])
  })

  it('never re-adopts a candidate whose device was removed (tombstone)', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1']
    await t.refresh()
    const deviceId = t.source.adopted.get('st-1')
    expect(deviceId).toBeDefined()
    // The operator removes the device: the source forgets the adoption, a tombstone appears.
    t.source.adopted.delete('st-1')
    t.tombstones.set(deviceId ?? 0, t.clock.t + 1)
    await t.refresh()
    expect(t.source.adoptCalls).toEqual(['st-1'])
  })

  it('never re-adopts a candidate the operator released', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1']
    await t.refresh()
    const deviceId = t.source.adopted.get('st-1') ?? 0
    t.source.adopted.delete('st-1')
    await t.autopilot.markReleased(ADDON, deviceId)
    await t.refresh()
    expect(t.source.adoptCalls).toEqual(['st-1'])
  })

  it('adopts a removed candidate again only after an explicit adopt', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1']
    await t.refresh()
    const first = t.source.adopted.get('st-1') ?? 0
    t.source.adopted.delete('st-1')
    t.tombstones.set(first, t.clock.t + 1)
    // The operator picks it again: the same job path, recorded as `operator`.
    const { jobId } = await t.engine.start({
      addonId: ADDON,
      integrationId: INTEGRATION,
      childNativeIds: ['st-1'],
    })
    await t.engine.waitForTest(jobId)
    const [record] = await t.autopilot.listRecords(ADDON, INTEGRATION)
    expect(record?.adoptedBy).toBe('operator')
    expect(record?.deviceId).not.toBe(first)
  })
})

describe('withdrawn (D1090)', () => {
  async function adoptedOne(adoptedBy: 'auto' | 'operator'): Promise<ReturnType<typeof setup>> {
    const t = setup()
    if (adoptedBy === 'auto') await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1', 'st-2']
    if (adoptedBy === 'operator') {
      const { jobId } = await t.engine.start({
        addonId: ADDON,
        integrationId: INTEGRATION,
        childNativeIds: ['st-1'],
      })
      await t.engine.waitForTest(jobId)
    }
    await t.refresh()
    return t
  }

  it('marks a device withdrawn after 3 confirmed discoveries without it, and removes nothing', async () => {
    const t = await adoptedOne('auto')
    t.source.listed = ['st-2']
    await t.refresh()
    await t.refresh()
    let rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptionState).toBe('offered')
    expect(rec?.missedDiscoveries).toBe(2)
    await t.refresh()
    rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptionState).toBe('withdrawn')
    expect(rec?.withdrawnSince).toBe(t.clock.t)
    // Kept: the source still holds the device, and nothing was released or re-adopted.
    expect(t.source.adopted.has('st-1')).toBe(true)
    expect(t.source.released).toEqual([])
    expect(t.source.adoptCalls).toEqual(['st-1', 'st-2'])
  })

  it('withdraws a device a person adopted just the same', async () => {
    const t = await adoptedOne('operator')
    t.source.listed = ['st-2']
    for (let i = 0; i < 3; i += 1) await t.refresh()
    const rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptedBy).toBe('operator')
    expect(rec?.adoptionState).toBe('withdrawn')
  })

  it('counts nothing on an empty or failed discovery', async () => {
    const t = await adoptedOne('auto')
    t.source.listed = []
    for (let i = 0; i < 4; i += 1) await t.refresh()
    t.source.listed = ['st-2']
    t.source.failList = true
    for (let i = 0; i < 4; i += 1) await t.refresh()
    t.source.failList = false
    for (let i = 0; i < 4; i += 1) await t.refresh({ lastError: 'HTTP 500' })
    const records = await t.autopilot.listRecords(ADDON, INTEGRATION)
    expect(records.every((r) => r.adoptionState === 'offered' && r.missedDiscoveries === 0)).toBe(
      true,
    )
  })

  it('returns a device to offered when its candidate comes back', async () => {
    const t = await adoptedOne('auto')
    t.source.listed = ['st-2']
    for (let i = 0; i < 3; i += 1) await t.refresh()
    t.source.listed = ['st-1', 'st-2']
    await t.refresh()
    const rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptionState).toBe('offered')
    expect(rec?.withdrawnSince).toBeNull()
    expect(rec?.missedDiscoveries).toBe(0)
  })

  it('counts no miss closer than the spacing: three quick refreshes stay offered (D1090)', async () => {
    const t = await adoptedOne('auto')
    t.source.listed = ['st-2']
    for (let i = 0; i < 3; i += 1) await t.refresh(undefined, 20_000)
    for (let i = 0; i < 3; i += 1) await t.refresh(undefined, 20_000)
    const rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptionState).toBe('offered')
    expect(rec?.missedDiscoveries).toBe(1)
  })

  it('withdraws after three misses a spacing apart', async () => {
    const t = await adoptedOne('auto')
    t.source.listed = ['st-2']
    await t.refresh()
    await t.refresh(undefined, 20_000)
    await t.refresh()
    await t.refresh()
    const rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.adoptionState).toBe('withdrawn')
    expect(rec?.missedDiscoveries).toBe(3)
  })
})

describe('what the autopilot skips (D1090)', () => {
  it('does not list candidates for a manual instance with no records', async () => {
    const t = setup()
    t.source.listed = ['st-1']
    const listSpy = vi.spyOn(t.source, 'listCandidates')
    await t.refresh()
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('stops the pass when the tombstones cannot be read (D49)', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1']
    t.tombstoneFails.value = true
    await t.refresh()
    expect(t.source.adoptCalls).toEqual([])
    expect(await t.autopilot.listRecords(ADDON, INTEGRATION)).toEqual([])
  })
})

describe('one pass per instance at a time (D1090)', () => {
  it('coalesces two overlapping refreshes: one miss, one adopt job', async () => {
    const t = setup()
    await t.autopilot.setMode(ADDON, INTEGRATION, 'auto')
    t.source.listed = ['st-1']
    await t.refresh()
    t.source.listed = ['st-2']
    t.source.adoptCalls.length = 0
    let open: () => void = () => {}
    t.source.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    t.clock.t += ADOPTION_MISS_MIN_SPACING_MS + 1_000
    const input = {
      addonId: ADDON,
      integrationId: INTEGRATION,
      status: {
        lastDiscoveryAt: t.clock.t,
        candidateCount: 1,
        adoptedCount: 1,
        lastError: null,
      },
    }
    const first = t.autopilot.afterRefresh(input)
    const second = t.autopilot.afterRefresh(input)
    open()
    await Promise.all([first, second])
    for (const job of t.engine.list({ addonId: ADDON })) await t.engine.waitForTest(job.jobId)
    expect(t.source.adoptCalls).toEqual(['st-2'])
    const rec = (await t.autopilot.listRecords(ADDON, INTEGRATION)).find(
      (r) => r.childNativeId === 'st-1',
    )
    expect(rec?.missedDiscoveries).toBe(1)
  })
})
