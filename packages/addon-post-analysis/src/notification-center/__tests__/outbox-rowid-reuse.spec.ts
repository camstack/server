/**
 * A reused event ROWID must not collide in the outbox (D694).
 *
 * The event tables are `INTEGER PRIMARY KEY` without AUTOINCREMENT (D474), so
 * SQLite reuses `max(rowid) + 1` once the newest rows are deleted. On
 * 2026-09-30 a deleted vehicle event on one camera and a new package pick-up on
 * another got the same id within 90 s. A package / audio / track-less object
 * row used to be deduped on that id alone (`rule:<recordId>:target`), so the
 * second record's notification was a dedup hit on the first's row.
 *
 * These pin, end to end and at the unit level:
 *
 * 1. the reuse itself happens (delete → insert hands back the same id);
 * 2. two records sharing a rowid both reach the outbox and both deliver;
 * 3. the same record replayed is still exactly-once;
 * 4. a row written BEFORE D694 still dedups its own record — hydrated and
 *    cold — and never a different record that reused the id;
 * 5. `supersede` drops only the combined alarm's OWN record.
 */

import {
  eventStoreLedgers,
  makeAnalyticsRecords,
} from '../../pipeline-analytics/__tests__/fake-records.js'
import type { InMemoryRecords, IScopedLogger, ObjectEvent, ObjectEventDraft } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { EventStore } from '../../pipeline-analytics/store/event-store.js'
import { incomingFromPackageEvent } from '../event-intake.js'
import { NotificationCenter } from '../index.js'
import { NcOutbox, type NcOutboxEnqueueInput, type NcOutboxEntry } from '../outbox.js'
import {
  isSameOutboxRecord,
  legacyOutboxEntryId,
  outboxEntryId,
  translatedLegacyEntryId,
} from '../outbox-key.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const T0 = 1_790_000_000_000

function packageDraft(deviceId: number, timestamp: number, trackId: string): ObjectEventDraft {
  return {
    kind: 'object',
    deviceId,
    timestamp,
    trackId,
    className: 'package',
    state: 'entered',
    zones: [],
    confidence: 1,
  }
}

/** Insert, delete, insert — the reuse, through the real EventStore. */
async function reusedIdPair(): Promise<{ first: ObjectEvent; second: ObjectEvent }> {
  const fake = makeFakeSettingsStore()
  const world = await makeAnalyticsRecords()
  const events = new EventStore({
    store: fake.client,
    logger: makeSilentLogger(),
    ...eventStoreLedgers(world.records),
  })
  await EventStore.declareObjectCollection(fake.client)
  const firstDraft = packageDraft(104, T0, 'trk-van')
  const firstId = await events.insertObject(firstDraft)
  if (firstId === null) throw new Error('first insert did not land')
  await events.deleteByTracks(['trk-van'])
  const secondDraft = { ...packageDraft(101, T0 + 90_000, 'trk-porch'), state: 'left' as const }
  const secondId = await events.insertObject(secondDraft)
  if (secondId === null) throw new Error('second insert did not land')
  return { first: { ...firstDraft, id: firstId }, second: { ...secondDraft, id: secondId } }
}

function makeCenter(world: InMemoryRecords, now: () => number): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
}

function outboxRows(world: InMemoryRecords): ReadonlyMap<string, Record<string, unknown>> {
  return ncTable(world, 'outbox')
}

describe('a reused event rowid never collides in the outbox (D694)', () => {
  let center: NotificationCenter | undefined
  afterEach(async () => {
    await center?.stop()
    center = undefined
  })

  it('reproduces the reuse: delete the newest row, the next insert gets its id', async () => {
    const { first, second } = await reusedIdPair()
    expect(second.id).toBe(first.id)
    expect(second.deviceId).not.toBe(first.deviceId)
  })

  it('two package records that share a rowid BOTH reach the outbox', async () => {
    const { first, second } = await reusedIdPair()
    const world = makeNcRecords()
    let now = T0
    center = makeCenter(world, () => now)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    await center.buildProvider().createRule({
      rule: NcRuleInputSchema.parse({
        name: 'Pacchi',
        delivery: 'package-event',
        targets: [{ targetId: 'tgt-1' }],
        conditions: { packagePhase: 'both' },
      }),
      caller: CALLER,
    })

    center.onPackageEventPersisted(first, 'delivered')
    await vi.waitFor(() => {
      expect(outboxRows(world).size).toBe(1)
    })
    now = T0 + 90_000
    center.onPackageEventPersisted(second, 'picked-up')
    await vi.waitFor(() => {
      expect(outboxRows(world).size).toBe(2)
    })
    const devices = [...outboxRows(world).values()].map((r) => r['deviceId']).sort()
    expect(devices).toEqual([101, 104])

    // The SAME record again (a replay) is still exactly-once. Awaited through
    // the reporting door, which rides the same serialized evaluation chain as
    // the live hook — so the assertion runs after the replay's enqueue, never
    // vacuously before it.
    const replay = await center.consumeEventAndReport(incomingFromPackageEvent(second, 'picked-up'))
    expect(replay.candidates).toBe(1)
    expect(outboxRows(world).size).toBe(2)
  })
})

// ── Unit level: the outbox and the key module ───────────────────────────

const RECORD_ID = '292786'

function packageInput(
  deviceId: number,
  recordAt: number,
  targetId = 'tgt-1',
): NcOutboxEnqueueInput {
  return {
    ruleId: 'rule-pkg',
    targetId,
    deviceId,
    recordKind: 'package-event',
    recordId: RECORD_ID,
    payload: {
      ruleName: 'Pacchi',
      delivery: 'package-event',
      priority: 3,
      media: 'best',
      subject: {
        deviceId,
        eventId: RECORD_ID,
        className: 'package',
        zones: [],
        timestamp: recordAt,
      },
    },
  }
}

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
}

/** A logger that keeps every line with its `tags.deviceId` (CLAUDE.md: device lines are tagged). */
function makeRecordingLogger(): { readonly logger: IScopedLogger; readonly lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const at =
    (level: string) =>
    (message: string, extras?: { tags?: Record<string, unknown> }): void => {
      lines.push({ level, message, deviceId: extras?.tags?.['deviceId'] })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

/** A rowid-kind row under the LEGACY id whose payload has no `subject` (malformed / very old). */
function seedMalformedLegacyRow(
  world: InMemoryRecords,
  status: 'sent' | 'pending',
  deviceId = 101,
  recordId = '777',
): string {
  const id = `rule-pkg:${recordId}:tgt-1`
  world.seed('outbox', {
    id: id,
    data: {
      ruleId: 'rule-pkg',
      targetId: 'tgt-1',
      deviceId,
      recordKind: 'package-event',
      recordId,
      status,
      attempts: status === 'sent' ? 1 : 0,
      nextAttemptAt: T0,
      createdAt: T0 + 100_000,
      updatedAt: T0 + 100_000,
      payload: { ruleName: 'Pacchi', delivery: 'package-event', priority: 3, media: 'best' },
    },
  })
  return id
}

function makeOutbox(world: InMemoryRecords, logger: IScopedLogger = makeSilentLogger()): NcOutbox {
  return new NcOutbox({
    records: world.records,
    logger,
    deliver: async () => ({ ok: true }),
    now: () => T0 + 200_000,
  })
}

/** A row exactly as the pre-D694 code wrote it: `rule:<recordId>:target`. */
function seedLegacyRow(
  world: InMemoryRecords,
  input: NcOutboxEnqueueInput,
  status: 'sent' | 'pending',
): string {
  const id = `${input.ruleId}:${input.recordId}:${input.targetId}`
  world.seed('outbox', {
    id: id,
    data: {
      ruleId: input.ruleId,
      targetId: input.targetId,
      deviceId: input.deviceId,
      recordKind: input.recordKind,
      recordId: input.recordId,
      status,
      attempts: status === 'sent' ? 1 : 0,
      nextAttemptAt: T0,
      createdAt: T0 + 100_000,
      updatedAt: T0 + 100_000,
      payload: input.payload,
    },
  })
  return id
}

describe('NcOutbox — rowid records are keyed by their generation (D694)', () => {
  it('two records sharing a rowid on two cameras are two rows', async () => {
    const world = makeNcRecords()
    const outbox = makeOutbox(world)
    await outbox.load()
    expect(await outbox.enqueue([packageInput(104, T0)])).toBe(1)
    expect(await outbox.enqueue([packageInput(101, T0 + 90_000)])).toBe(1)
    expect(await outbox.enqueue([packageInput(101, T0 + 90_000)])).toBe(0)
  })

  it('a reuse on the SAME camera is told apart by the record timestamp', async () => {
    const world = makeNcRecords()
    const outbox = makeOutbox(world)
    await outbox.load()
    expect(await outbox.enqueue([packageInput(101, T0)])).toBe(1)
    expect(await outbox.enqueue([packageInput(101, T0 + 1)])).toBe(1)
  })

  describe('a row written before D694', () => {
    it('hydrated: still dedups its OWN record, and only its own', async () => {
      const world = makeNcRecords()
      seedLegacyRow(world, packageInput(104, T0), 'sent')
      const outbox = makeOutbox(world)
      await outbox.load()
      expect(outbox.hydrated()).toBe(true)
      // The boot reconcile replaying the record it was written for: no re-send.
      expect(await outbox.enqueue([packageInput(104, T0)])).toBe(0)
      // A DIFFERENT record that reused the id: delivered.
      expect(await outbox.enqueue([packageInput(101, T0 + 90_000)])).toBe(1)
    })

    it('cold horizon: the store probe accepts the old spelling only for the same record', async () => {
      const world = makeNcRecords()
      seedLegacyRow(world, packageInput(104, T0), 'sent')
      const outbox = makeOutbox(world)
      // No load(): the horizon is cold, enqueue asks the store.
      expect(outbox.hydrated()).toBe(false)
      expect(await outbox.enqueue([packageInput(104, T0)])).toBe(0)
      expect(await outbox.enqueue([packageInput(101, T0 + 90_000)])).toBe(1)
    })

    it('a legacy row with no record timestamp cannot break the hydrate of every other row', async () => {
      const world = makeNcRecords()
      seedLegacyRow(world, packageInput(104, T0), 'sent')
      // A malformed rowid-kind row under the legacy spelling: no `subject`.
      world.seed('outbox', {
        id: 'rule-pkg:777:tgt-1',
        data: {
          ruleId: 'rule-pkg',
          targetId: 'tgt-1',
          deviceId: 101,
          recordKind: 'package-event',
          recordId: '777',
          status: 'sent',
          attempts: 1,
          nextAttemptAt: T0,
          createdAt: T0 + 100_000,
          updatedAt: T0 + 100_000,
          payload: { ruleName: 'Pacchi', delivery: 'package-event', priority: 3, media: 'best' },
        },
      })
      const outbox = makeOutbox(world)
      await outbox.load()
      expect(outbox.hydrated()).toBe(true)
      // The well-formed legacy row still dedups its own record.
      expect(await outbox.enqueue([packageInput(104, T0)])).toBe(0)
    })

    it('cold probe: a legacy row with no record timestamp dedups nothing, and says so per camera', async () => {
      const world = makeNcRecords()
      seedMalformedLegacyRow(world, 'sent', 104, RECORD_ID)
      const { logger, lines } = makeRecordingLogger()
      const outbox = makeOutbox(world, logger)
      expect(outbox.hydrated()).toBe(false)
      // Same legacy spelling as this record, but unprovable: duplicate over lost.
      expect(await outbox.enqueue([packageInput(104, T0)])).toBe(1)
      const warn = lines.find(
        (l) => l.level === 'warn' && l.message.includes('no record timestamp'),
      )
      expect(warn?.deviceId).toBe(104)
    })

    it('hydrate: the malformed row WARNs tagged with its camera', async () => {
      const world = makeNcRecords()
      seedMalformedLegacyRow(world, 'sent', 101)
      const { logger, lines } = makeRecordingLogger()
      await makeOutbox(world, logger).load()
      const warn = lines.find(
        (l) => l.level === 'warn' && l.message.includes('no record timestamp'),
      )
      expect(warn?.deviceId).toBe(101)
    })

    it('a pending legacy row is re-hydrated under its stored id and still delivers', async () => {
      const world = makeNcRecords()
      const id = seedLegacyRow(world, packageInput(104, T0), 'pending')
      const delivered: string[] = []
      const outbox = new NcOutbox({
        records: world.records,
        logger: makeSilentLogger(),
        deliver: async (entry: NcOutboxEntry) => {
          delivered.push(entry.id)
          return { ok: true }
        },
        now: () => T0 + 200_000,
      })
      await outbox.load()
      expect(outbox.pendingCount()).toBe(1)
      await outbox.drainOnce()
      expect(delivered).toEqual([id])
      expect(ncTable(world, 'outbox')?.get(id)?.['status']).toBe('sent')
    })
  })

  it('supersede skips a pending row with no record timestamp instead of throwing', async () => {
    const world = makeNcRecords()
    seedMalformedLegacyRow(world, 'pending', 101, RECORD_ID)
    const outbox = makeOutbox(world)
    await outbox.load()
    await outbox.enqueue([packageInput(104, T0)])
    expect(outbox.pendingCount()).toBe(2)
    const dropped = await outbox.supersede({
      ruleId: 'rule-pkg',
      recordId: RECORD_ID,
      deviceId: 104,
      recordAt: T0,
      targetIds: ['tgt-1'],
    })
    expect(dropped).toBe(1)
    // The malformed row is untouched: it is not provably this record.
    expect(outbox.pendingCount()).toBe(1)
  })

  it('supersede drops the alarm source record and never a different record on the reused id', async () => {
    const world = makeNcRecords()
    const outbox = makeOutbox(world)
    await outbox.load()
    await outbox.enqueue([packageInput(104, T0), packageInput(101, T0 + 90_000)])
    expect(outbox.pendingCount()).toBe(2)
    const dropped = await outbox.supersede({
      ruleId: 'rule-pkg',
      recordId: RECORD_ID,
      deviceId: 101,
      recordAt: T0 + 90_000,
      targetIds: ['tgt-1'],
    })
    expect(dropped).toBe(1)
    const left = [...(ncTable(world, 'outbox')?.values() ?? [])]
    expect(left.map((r) => r['deviceId'])).toEqual([104])
  })
})

describe('outbox-key', () => {
  const base = packageInput(101, T0)

  it('a rowid record carries its generation: <recordId>@<deviceId>:<recordAt>', () => {
    expect(outboxEntryId(base)).toBe(`rule-pkg:${RECORD_ID}@101:${String(T0)}:tgt-1`)
  })

  it('a track-scoped row keeps the track id — unchanged by D694', () => {
    expect(outboxEntryId({ ...base, recordKind: 'object-event', trackId: 'k3m9x2v7qa' })).toBe(
      'rule-pkg:k3m9x2v7qa:tgt-1',
    )
    expect(
      legacyOutboxEntryId({ ...base, recordKind: 'object-event', trackId: 'k3m9x2v7qa' }),
    ).toBeNull()
  })

  it('an explicit dedup ref wins', () => {
    expect(outboxEntryId({ ...base, dedupRef: 'g:101:1:v2' })).toBe('rule-pkg:g:101:1:v2:tgt-1')
  })

  it('a non-rowid kind keeps its record id — synthetic ids already carry device and instant', () => {
    const timelapse = { ...base, recordKind: 'timelapse' as const, recordId: 'timelapse:101:99' }
    expect(outboxEntryId(timelapse)).toBe('rule-pkg:timelapse:101:99:tgt-1')
    expect(legacyOutboxEntryId(timelapse)).toBeNull()
    const sensor = { ...base, recordKind: 'device-event' as const, recordId: 'b2c1-uuid' }
    expect(outboxEntryId(sensor)).toBe('rule-pkg:b2c1-uuid:tgt-1')
  })

  it('translates only a stored id that IS the legacy spelling', () => {
    expect(translatedLegacyEntryId(`rule-pkg:${RECORD_ID}:tgt-1`, base)).toBe(outboxEntryId(base))
    expect(translatedLegacyEntryId(outboxEntryId(base), base)).toBeNull()
  })

  it('isSameOutboxRecord needs id, camera AND record timestamp', () => {
    const a = { recordId: RECORD_ID, deviceId: 101, recordAt: T0 }
    expect(isSameOutboxRecord(a, { ...a })).toBe(true)
    expect(isSameOutboxRecord(a, { ...a, deviceId: 104 })).toBe(false)
    expect(isSameOutboxRecord(a, { ...a, recordAt: T0 + 1 })).toBe(false)
  })
})
