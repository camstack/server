/**
 * The deleted-device prune, through the REAL centre: the event door is shut
 * on every node but the evaluating one (the single writer), and the reload
 * tick's reconcile is wired to the directory refresh that precedes it.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, withNcFaults } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NcDeviceIdentity } from '../device-directory.js'
import { NcPruneLedger } from '../device-prune-ledger.js'
import { NotificationCenter } from '../index.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeRecordingLogger } from './device-prune-harness.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const DEAD = 102
const LIVE = 101

interface CenterHarness {
  readonly center: NotificationCenter
  readonly secondReads: number[]
  readonly catalogReads: { count: number }
  /** Queries of the prune collection, counted at the store. */
  readonly ledgerReads: { count: number }
  readonly world: InMemoryRecords
}

function identity(deviceId: number): NcDeviceIdentity {
  return { deviceId, type: 'camera', name: `cam ${deviceId}`, isCamera: true }
}

async function makeCenter(listed: readonly number[], reloadMs = 3_600_000): Promise<CenterHarness> {
  const world = makeNcRecords()
  const secondReads: number[] = []
  const catalogReads = { count: 0 }
  const ledgerReads = { count: 0 }
  const counted = withNcFaults(world, {
    aroundQuery: (kind, read) => {
      if (kind === 'device-prunes') ledgerReads.count += 1
      return read()
    },
  })
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: counted.records,
    logger: makeRecordingLogger().logger,
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    dispatcher: {
      listTargets: async () => {
        catalogReads.count += 1
        return [{ id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true }]
      },
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Driveway',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => listed.map(identity),
    isDeviceDeleted: async (deviceId) => {
      secondReads.push(deviceId)
      return deviceId === DEAD
    },
    now: () => 100_000,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: reloadMs,
  })
  return { center, secondReads, catalogReads, ledgerReads, world }
}

async function createRule(center: NotificationCenter): Promise<string> {
  const { rule } = await center.buildProvider().createRule({
    rule: NcRuleInputSchema.parse({
      name: 'two cameras',
      delivery: 'immediate',
      targets: [{ targetId: 'tgt-1' }],
      conditions: { devices: [LIVE, DEAD] },
    }),
    caller: CALLER,
  })
  return rule.id
}

describe('deleted-device prune — through the centre', () => {
  let h: CenterHarness

  afterEach(async () => {
    await h.center.stop()
  })

  it('the evaluating node prunes on DeviceUnregistered once getDevice agrees', async () => {
    h = await makeCenter([LIVE, DEAD])
    await h.center.start({ evaluation: true })
    const ruleId = await createRule(h.center)
    await h.center.onDeviceDeleted(DEAD)
    expect(h.center.ruleStore.get(ruleId)?.conditions.devices).toEqual([LIVE])
    await expect(h.center.listPrunes()).resolves.toEqual([
      expect.objectContaining({ ruleId, subject: '102', outcome: 'removed', source: 'event' }),
    ])
  })

  it('a node that does not evaluate never prunes, and never even asks', async () => {
    h = await makeCenter([LIVE, DEAD])
    await h.center.start({ evaluation: false })
    const ruleId = await createRule(h.center)
    await h.center.onDeviceDeleted(DEAD)
    expect(h.center.ruleStore.get(ruleId)?.conditions.devices).toEqual([LIVE, DEAD])
    expect(h.secondReads).toEqual([])
  })

  it('the reload tick reconciles a deletion whose event was lost', async () => {
    h = await makeCenter([LIVE], 5)
    await h.center.start({ evaluation: true })
    const ruleId = await createRule(h.center)
    await vi.waitFor(
      () => {
        expect(h.center.ruleStore.get(ruleId)?.conditions.devices).toEqual([LIVE])
      },
      { timeout: 2_000, interval: 10 },
    )
    expect((await h.center.listPrunes())[0]).toMatchObject({ source: 'reconcile' })
  })

  it('reload ticks read NO target catalog of their own (fix round 1)', async () => {
    h = await makeCenter([LIVE], 5)
    await h.center.start({ evaluation: true })
    const ruleId = await createRule(h.center)
    const before = h.catalogReads.count
    // The device reconcile landing proves the ticks ran.
    await vi.waitFor(
      () => {
        expect(h.center.ruleStore.get(ruleId)?.conditions.devices).toEqual([LIVE])
      },
      { timeout: 2_000, interval: 10 },
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.catalogReads.count).toBe(before)
  })

  it('the evaluating node (the only writer) does not re-query its prune record every tick', async () => {
    h = await makeCenter([LIVE], 5)
    await h.center.start({ evaluation: true })
    const ruleId = await createRule(h.center)
    const afterStart = h.ledgerReads.count
    await vi.waitFor(
      () => {
        expect(h.center.ruleStore.get(ruleId)?.conditions.devices).toEqual([LIVE])
      },
      { timeout: 2_000, interval: 10 },
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.ledgerReads.count).toBe(afterStart)
  })

  it('a non-evaluating node answers nc.listPrunes from the store, read at the request', async () => {
    h = await makeCenter([LIVE, DEAD])
    await h.center.start({ evaluation: false })
    // The evaluating node (another process) records a prune after this start.
    const writer = new NcPruneLedger({
      records: h.world.records,
      logger: makeSilentLogger(),
    })
    await writer.load()
    await writer.record(
      [
        {
          kind: 'rule',
          ruleId: 'r1',
          subjectKind: 'device',
          subject: '102',
          field: 'conditions.devices',
          outcome: 'kept-disabled',
        },
      ],
      'event',
      1,
    )
    await expect(h.center.listPrunes()).resolves.toEqual([
      expect.objectContaining({ ruleId: 'r1', outcome: 'kept-disabled' }),
    ])
  })
})
