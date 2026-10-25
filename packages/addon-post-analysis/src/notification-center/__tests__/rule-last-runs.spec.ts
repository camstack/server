/**
 * `notificationRules.getRuleLastRuns` — the "Last run" column of a rules table.
 *
 * A projection of the SAME outbox `getHistory` reads (history is a view over
 * it; so is this), answered in ONE bounded read: one store query, projected to
 * the four columns it reads, over the window the outbox is kept for. Never a
 * query per rule, and never a scan per rule over the rows.
 *
 * What a caller is promised, and what these specs pin:
 *  - the newest row per rule, with that row's status and camera;
 *  - a rule with no row in the window is ABSENT — and `horizonMs` says how far
 *    back "absent" was looked, so a UI can say "not in the last 7 days";
 *  - a store that cannot answer FAILS the call. An empty `runs` from a failed
 *    read would tell every rule it has not run (D315, D393).
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, type NcRecordsQuery, withNcFaults } from './support/nc-test-deps.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { PruneWindows } from '../prune-windows.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { NcOutbox } from '../outbox.js'
import { NC_RULE_LAST_RUNS_SCAN_LIMIT, summariseRuleLastRuns } from '../rule-last-runs.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const DAY_MS = 24 * 3_600_000
const NOW = 100 * DAY_MS

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

interface Harness {
  readonly center: NotificationCenter
  readonly world: InMemoryRecords
  /** Every outbox query the centre sent, in order. */
  readonly outboxReads: NcRecordsQuery[]
  /** From now on every read fails with this message. */
  failReads(message: string): void
}

async function makeCenter(outboxMs: number | null = 7 * DAY_MS): Promise<Harness> {
  const base = makeNcRecords()
  const outboxReads: NcRecordsQuery[] = []
  let readFault: string | null = null
  const world = withNcFaults(base, {
    read: (kind, query) => {
      if (kind === 'outbox' && query !== undefined) outboxReads.push(query)
      return readFault
    },
  })
  const windows: PruneWindows = {
    outboxMs,
    timelapseExportMs: null,
    artifactShelfMs: null,
    summaryMosaicMs: null,
  }
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => windows,
    dispatcher: {
      listTargets: async () => [],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    now: () => NOW,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: false })
  return {
    center,
    world: base,
    outboxReads,
    failReads: (message) => {
      readFault = message
    },
  }
}

interface SeedRow {
  readonly id: string
  readonly ruleId: string
  readonly createdAt: number
  readonly status: 'pending' | 'sent' | 'dead'
  readonly deviceId?: number
}

function seed(world: InMemoryRecords, rows: readonly SeedRow[]): void {
  for (const r of rows) {
    world.seed('outbox', {
      id: r.id,
      data: {
        id: r.id,
        ruleId: r.ruleId,
        targetId: 'tgt-1',
        deviceId: r.deviceId ?? 104,
        recordKind: 'object-event',
        recordId: `rec-${r.id}`,
        status: r.status,
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
        payload: { ruleName: 'heavy', subject: { deviceId: 104 } },
      },
    })
  }
}

describe('getRuleLastRuns', () => {
  it('answers the NEWEST row per rule, with its status and camera', async () => {
    const { center, world } = await makeCenter()
    seed(world, [
      { id: 'a1', ruleId: 'r-a', createdAt: NOW - 3 * DAY_MS, status: 'sent', deviceId: 104 },
      { id: 'a2', ruleId: 'r-a', createdAt: NOW - 1 * DAY_MS, status: 'dead', deviceId: 102 },
      { id: 'b1', ruleId: 'r-b', createdAt: NOW - 2 * DAY_MS, status: 'pending', deviceId: 101 },
    ])
    const out = await center.buildProvider().getRuleLastRuns({})
    const byRule = new Map(out.runs.map((r) => [r.ruleId, r]))
    expect(byRule.get('r-a')).toEqual({
      ruleId: 'r-a',
      lastAt: NOW - 1 * DAY_MS,
      status: 'dead',
      deviceId: 102,
    })
    expect(byRule.get('r-b')).toEqual({
      ruleId: 'r-b',
      lastAt: NOW - 2 * DAY_MS,
      status: 'pending',
      deviceId: 101,
    })
    expect(out.runs).toHaveLength(2)
  })

  it('one fire, several targets: the least successful status of that fire wins', async () => {
    const { center, world } = await makeCenter()
    const at = NOW - DAY_MS
    seed(world, [
      { id: 'x-t1', ruleId: 'r-x', createdAt: at, status: 'sent' },
      { id: 'x-t2', ruleId: 'r-x', createdAt: at, status: 'dead' },
      { id: 'x-t3', ruleId: 'r-x', createdAt: at, status: 'sent' },
    ])
    const out = await center.buildProvider().getRuleLastRuns({})
    expect(out.runs).toEqual([{ ruleId: 'r-x', lastAt: at, status: 'dead', deviceId: 104 }])
  })

  it('a rule with no row inside the horizon is ABSENT, and the horizon is the prune window', async () => {
    const { center, world } = await makeCenter(7 * DAY_MS)
    seed(world, [
      // Older than the window — still on disk (the prune runs at boot only),
      // and still not an answer to "did it run in the last 7 days".
      { id: 'old', ruleId: 'r-old', createdAt: NOW - 8 * DAY_MS, status: 'sent' },
      { id: 'new', ruleId: 'r-new', createdAt: NOW - DAY_MS, status: 'sent' },
    ])
    const out = await center.buildProvider().getRuleLastRuns({})
    expect(out.runs.map((r) => r.ruleId)).toEqual(['r-new'])
    expect(out.horizonMs).toBe(7 * DAY_MS)
  })

  it('reads the outbox newest-first in pages — no query per rule', async () => {
    const { center, world, outboxReads: reads } = await makeCenter()
    const rows: SeedRow[] = []
    for (let i = 0; i < 40; i += 1) {
      rows.push({
        id: `row-${i}`,
        ruleId: `r-${i % 8}`,
        createdAt: NOW - (i + 1) * 60_000,
        status: 'sent',
      })
    }
    seed(world, rows)
    const before = reads.length
    const out = await center.buildProvider().getRuleLastRuns({})
    expect(out.runs).toHaveLength(8)
    expect(reads.length - before).toBe(1)
    const input = reads[before]
    // One records page (40 rows fit), never the whole scan bound in one read.
    expect(input?.limit).toBeLessThan(NC_RULE_LAST_RUNS_SCAN_LIMIT)
    // Newest-first over the fire time: the range is what the order rides on.
    expect(input?.desc).toBe(true)
    expect(input?.where).toHaveProperty('createdAt')
  })

  it('a store that cannot answer FAILS the call — it never answers "no rule ran"', async () => {
    const { center, world, failReads } = await makeCenter()
    seed(world, [{ id: 'a', ruleId: 'r-a', createdAt: NOW - DAY_MS, status: 'sent' }])
    failReads('SQLITE_BUSY')
    await expect(center.buildProvider().getRuleLastRuns({})).rejects.toThrow(/SQLITE_BUSY/)
  })

  it('"keep forever" (no prune window) answers a null horizon', async () => {
    const { center, world } = await makeCenter(null)
    seed(world, [{ id: 'a', ruleId: 'r-a', createdAt: NOW - 90 * DAY_MS, status: 'sent' }])
    const out = await center.buildProvider().getRuleLastRuns({})
    expect(out.horizonMs).toBeNull()
    expect(out.runs.map((r) => r.ruleId)).toEqual(['r-a'])
  })
})

describe('summariseRuleLastRuns — a truncated scan never claims the full window', () => {
  it('a read that hit its bound narrows the horizon to the oldest row it read', () => {
    const out = summariseRuleLastRuns(
      {
        rows: [
          { ruleId: 'r-a', createdAt: NOW - 1_000, status: 'sent', deviceId: 1 },
          { ruleId: 'r-b', createdAt: NOW - 5_000, status: 'sent', deviceId: 2 },
        ],
        truncated: true,
        oldestReadAt: NOW - 5_000,
      },
      { now: NOW, windowMs: 7 * DAY_MS },
    )
    // A rule whose newest row is older than 5 s may exist beyond the cut; the
    // answer only covers what it read.
    expect(out.horizonMs).toBe(5_000)
    expect(out.runs.map((r) => r.ruleId)).toEqual(['r-a', 'r-b'])
  })

  it('an untruncated read covers the whole window', () => {
    const out = summariseRuleLastRuns(
      {
        rows: [{ ruleId: 'r-a', createdAt: NOW - 1_000, status: 'sent', deviceId: 1 }],
        truncated: false,
        oldestReadAt: NOW - 1_000,
      },
      { now: NOW, windowMs: 7 * DAY_MS },
    )
    expect(out.horizonMs).toBe(7 * DAY_MS)
  })
})

describe('queryLastRunRows — truncation is judged on what the STORE returned', () => {
  it('a truncated read with a malformed row still shrinks the horizon', async () => {
    const world = makeNcRecords()
    const outbox = new NcOutbox({
      records: world.records,
      logger: makeSilentLogger(),
      deliver: async () => ({ ok: true }),
      now: () => NOW,
    })
    seed(world, [
      { id: 'a', ruleId: 'r-a', createdAt: NOW - 1_000, status: 'sent' },
      { id: 'b', ruleId: 'r-b', createdAt: NOW - 2_000, status: 'sent' },
    ])
    // The oldest row the store hands back is unreadable (a status the guard
    // refuses). Dropping it must not make a 3-row read look like 2 of 3.
    world.seed('outbox', {
      id: 'bad',
      data: { ruleId: 'r-c', createdAt: NOW - 3_000, status: '??', deviceId: 1 },
    })
    const read = await outbox.queryLastRunRows(null, 3)
    expect(read.rows).toHaveLength(2)
    expect(read.truncated).toBe(true)
    expect(read.oldestReadAt).toBe(NOW - 3_000)
    const out = summariseRuleLastRuns(read, { now: NOW, windowMs: 7 * DAY_MS })
    expect(out.horizonMs).toBe(3_000)
  })
})
