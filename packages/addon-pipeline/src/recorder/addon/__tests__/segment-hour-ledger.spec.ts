/**
 * SegmentHourLedger — the durable ACCOUNT of the recorder's archive.
 *
 * Hour-directory granularity (not one row per 10 s segment): RecordingIndex's
 * own bucket is already `<dev>/<profile>/Y/M/D/H`, and ~1.6 M live segments
 * collapse to a few thousand hour rows. The walk remains the authority for
 * DELETE (D148); an empty/corrupt ledger must look like "never walked".
 *
 * Since D523 the row is ten scalars and names no file: the DIRECTORY is the
 * authority for WHICH segments exist and this table for HOW MUCH. So every
 * assertion below about what an hour holds is an assertion about its aggregate,
 * and the only thing that can seed `RecordingIndex` is a listing.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import {
  LEDGER_LOAD_MAX_ATTEMPTS,
  LEDGER_LOAD_RETRY_MS,
  LEDGER_LOAD_SLOW_RETRY_MS,
  RECORDING_SEGMENT_HOURS_COLLECTION,
  SegmentHourLedger,
} from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS

function silentLogger(): IScopedLogger {
  const noop = () => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  } as unknown as IScopedLogger
}

interface Recorded {
  readonly message: string
  readonly extras: unknown
}

/** A logger whose warn lines are assertable — a refusal that is not said out
 *  loud is indistinguishable from a prune that never had anything to do. */
function warnRecordingLogger(warns: Recorded[]): IScopedLogger {
  const noop = () => {}
  const logger = {
    debug: noop,
    info: noop,
    warn: (message: string, extras?: unknown) => warns.push({ message, extras }),
    error: noop,
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function fakeStore(): SettingsStoreClient {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const declared = new Set<string>()
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let m = tables.get(collection)
    if (!m) {
      m = new Map()
      tables.set(collection, m)
    }
    return m
  }
  return {
    declareCollection: {
      mutate: async (input: { collection: string }) => {
        declared.add(input.collection)
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: { collection: string; key: string; value: unknown }) => {
        ensure(input.collection).set(input.key, input.value as Record<string, unknown>)
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }) => {
        tables.get(input.collection)?.delete(input.key)
      },
    },
    query: {
      query: async (input: { collection: string; filter?: { limit?: number } }) => {
        const rows = [...(tables.get(input.collection)?.entries() ?? [])].map(([id, data]) => ({
          id,
          data,
        }))
        const limit = input.filter?.limit
        return limit === undefined ? rows : rows.slice(0, limit)
      },
    },
  } as unknown as SettingsStoreClient
}

function row(
  startMs: number,
  bytes = 100,
  profile = 'high',
  locationId = 'recordings',
  deviceId = 99,
): SegmentRow {
  return {
    deviceId,
    profile,
    startMs,
    durMs: 10_000,
    bytes,
    path: segmentRelPath(deviceId, profile, startMs, 10_000, bytes),
    locationId,
  }
}

async function openLedger(
  store: SettingsStoreClient = fakeStore(),
): Promise<{ ledger: SegmentHourLedger; store: SettingsStoreClient }> {
  const ledger = new SegmentHourLedger({ store, logger: silentLogger() })
  await ledger.declare()
  return { ledger, store }
}

describe('SegmentHourLedger', () => {
  it('declares the recording-hours collection', async () => {
    const store = fakeStore()
    const ledger = new SegmentHourLedger({ store, logger: silentLogger() })
    await ledger.declare()
    const declared = await store.query.query({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
    })
    expect(Array.isArray(declared)).toBe(true)
  })

  it('write-behind on finalize survives a restart as the hour ACCOUNT', async () => {
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    const a = row(HOUR0 + 1_000)
    const b = row(HOUR0 + 11_000, 200)
    await first.recordSegment(a)
    await first.recordSegment(b)

    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    const loaded = await restarted.load()
    expect(loaded).toHaveLength(1)

    // Since D523 the row says how MUCH the hour holds and never which files, so
    // the restart recovers the account exactly and recovers no path at all.
    expect(loaded[0]).toMatchObject({
      deviceId: 99,
      profile: 'high',
      locationId: 'recordings',
      hourStartMs: HOUR0,
      bytes: 300,
      segments: 2,
      minStartMs: HOUR0 + 1_000,
      maxStartMs: HOUR0 + 11_000,
    })

    // And the index is untouched by all of it: the hour is `unknown` until a
    // directory listing seeds it, which is now the only thing that can.
    const index = new RecordingIndex()
    expect(index.hydrationOf(99, HOUR0, HOUR0 + HOUR_MS)).toBe('unknown')
    expect(index.accounting(99).count).toBe(0)
  })

  it('an empty ledger knows no hour — fail toward the walk', async () => {
    const { ledger } = await openLedger()
    await ledger.load()
    const index = new RecordingIndex()
    expect(ledger.snapshot()).toEqual([])
    expect(ledger.hourRow(99, 'high', 'recordings', HOUR0)).toBeUndefined()
    expect(index.accounting(99).count).toBe(0)
    expect(index.hydrationOf(99, HOUR0, HOUR0 + HOUR_MS)).toBe('unknown')
  })

  it('skips a malformed hour row rather than accounting for a phantom archive', async () => {
    const store = fakeStore()
    const bootstrap = new SegmentHourLedger({ store, logger: silentLogger() })
    await bootstrap.declare()
    await store.set.mutate({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      key: 'junk',
      value: { deviceId: 'nope', segments: 'not-a-number' },
    })
    const ledger = new SegmentHourLedger({ store, logger: silentLogger() })
    await ledger.declare()
    const loaded = await ledger.load()
    // Skipped, never repaired: a row that cannot say which camera, profile,
    // location and hour it is about would gate the write path for an hour that
    // is perfectly fine.
    expect(loaded).toEqual([])
    expect(ledger.snapshot()).toEqual([])
  })

  it('shrinks the hour on eviction and forgets it when the last segment goes', async () => {
    const { ledger } = await openLedger()
    const a = row(HOUR0 + 1_000)
    const b = row(HOUR0 + 11_000, 200)
    await ledger.recordSegment(a)
    await ledger.recordSegment(b)
    await ledger.dropSegments([a])
    expect(ledger.snapshot()).toHaveLength(1)
    // The aggregate shrinks by exactly what was evicted; the row is left
    // UNSEALED because arithmetic shrank it and only a listing can re-derive
    // the edges it cannot fix (D523).
    expect(ledger.snapshot()[0]).toMatchObject({ segments: 1, bytes: 200, sealed: false })
    await ledger.dropSegments([b])
    expect(ledger.snapshot()).toEqual([])
  })

  it('reconcile keeps ledger extras in the current hour and drops them only when the walk confirms an older hour empty', async () => {
    const { ledger } = await openLedger()
    const live = row(HOUR0 + 50_000)
    const stale = row(HOUR0 - HOUR_MS + 1_000)
    await ledger.recordSegment(live)
    await ledger.recordSegment(stale)

    const index = new RecordingIndex()
    // Walk found the live hour empty of *disk* rows (writer has not relocated
    // yet) and the previous hour gone from disk.
    await ledger.reconcileFromIndex(index, [99], HOUR0 + 60_000)

    expect(
      ledger
        .snapshot()
        .map((h) => h.hourStartMs)
        .toSorted(),
    ).toEqual([HOUR0])
    // The reconcile compares AGGREGATES now: the live hour keeps the account
    // the writer built, because the walk's is not larger.
    expect(ledger.snapshot()[0]).toMatchObject({ segments: 1, bytes: live.bytes })
  })

  it('reconcile adds disk-only hours the ledger missed', async () => {
    const { ledger } = await openLedger()
    const onDisk = row(HOUR0 + 1_000)
    const index = new RecordingIndex()
    index.addSegment(onDisk)
    await ledger.reconcileFromIndex(index, [99], HOUR0 + 60_000)
    expect(ledger.snapshot()).toHaveLength(1)
    expect(ledger.snapshot()[0]).toMatchObject({
      hourStartMs: HOUR0,
      segments: 1,
      bytes: onDisk.bytes,
      minStartMs: onDisk.startMs,
      maxStartMs: onDisk.startMs,
    })
  })

  /**
   * The `paths` column used to make the write path idempotent for free — an
   * append asked `held.paths.includes(path)`. With the column gone the
   * aggregate cannot say whether it already counted a name, so the dedup is the
   * in-process `accounted` set, and that set is bounded to the hours THIS
   * process writes. The consequence is deliberate and must be pinned, not
   * assumed: a duplicate that survives a restart is NOT caught, and the row it
   * inflated is left unsealed so the first listing of the closed hour corrects
   * it exactly.
   */
  it('recordSegment is idempotent on path IN THIS PROCESS — a replay does not duplicate', async () => {
    const { ledger } = await openLedger()
    const a = row(HOUR0 + 1_000)
    await ledger.recordSegment(a)
    await ledger.recordSegment(a)
    expect(ledger.snapshot()[0]).toMatchObject({ segments: 1, bytes: a.bytes })
  })

  it('a replay ACROSS a restart double-counts, and the first listing of the hour fixes it', async () => {
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    const a = row(HOUR0 + 1_000)
    await first.recordSegment(a)

    // A fresh process knows nothing of what the last one accounted for, so the
    // same finalize replayed after a respawn is counted a second time.
    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()
    await restarted.recordSegment(a)
    expect(restarted.snapshot()[0]).toMatchObject({ segments: 2, sealed: false })

    // The directory is the authority for WHICH segments exist (D523): one
    // listing of the closed hour replaces the account with the truth and seals
    // it. That is the whole reason an inflated row is survivable.
    const outcome = await restarted.adoptWalkedHour(99, 'high', 'recordings', HOUR0, [a.path])
    expect(outcome).toEqual({ created: false, added: 0, sealedNow: true })
    expect(restarted.snapshot()[0]).toMatchObject({
      segments: 1,
      bytes: a.bytes,
      sealed: true,
    })
  })
})

describe('recorder addon wires the hour ledger (Boot phase 2)', () => {
  // Anchored to THIS file, not process.cwd(): the suite must pass whether
  // vitest runs from the package dir (nx) or the repo root.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
    'utf8',
  )

  it('loads the ledger and does not arm the fleet FUSE walk', () => {
    // Live 2026-08-22: the deferred walk took 38–392 s per camera on shfs
    // and starved scrub (`segment read timeout` 8 s). Locate/getAvailability
    // already hydrate the window they ask about; the ledger reseeds RAM.
    expect(source).toContain('SegmentHourLedger')
    expect(source).toContain('this.segmentHours?.load()')
    expect(source).toContain('recorder: full-archive index walk skipped')
    expect(source).not.toContain('this.scheduleDeferredFullWalk(')
  })

  it('boot REPLAYS NOTHING into the index (D287)', () => {
    // The archive replay is the thing stage 2 deleted: it folded every ledger
    // hour into `RecordingIndex` synchronously, and — worse than its cost — it
    // marked every one of them `hydrated`, so a tail lost between a persist and
    // a crash was permanently invisible to playback and the timeline rather
    // than merely under-reported.
    expect(source).not.toContain('hydrateIndex')
  })

  it('every window hydrate asks the LEDGER before it asks the array', () => {
    // A `readdir` of one hour directory was ~650 ms on the live share under
    // load, against the disk the scrub feeder is competing for. Since the boot
    // replay is gone, a ledger-known hour arrives at the reader `unknown` — if
    // the ledger were not passed in, every one of them would go to the array.
    const calls = source.split('hydrateWindowFromStorage(').slice(1)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const call of calls) {
      expect(call.slice(0, call.indexOf(')'))).toContain('this.segmentHours')
    }
  })

  it('write-behind on finalize and drops on eviction, then reconciles after the walk', () => {
    expect(source).toContain('recordSegment(')
    expect(source).toContain('dropSegments(')
    expect(source).toContain('reconcileFromIndex(')
  })

  it('starts writers before loading the ledger — recording must not wait on the index', () => {
    const startAt = source.indexOf('this.controller?.start()')
    const loadAt = source.indexOf('this.segmentHours?.load()')
    expect(startAt).toBeGreaterThan(0)
    expect(loadAt).toBeGreaterThan(startAt)
  })
})

/**
 * A walk over a root that is not there NEVER shrinks the ledger.
 *
 * On the boot of 2026-08-19 the recorder respawned while `/recordings` was an
 * empty tmpfs — the UD disk had not mounted. The archive walk saw almost
 * nothing, `reconcileFromIndex` read that as "these hours are gone from disk"
 * and pruned the ledger from 873 hours to 32. Nothing was recoverable from
 * that: the ledger IS the thing that lets the next boot skip a ~400 s recursive
 * walk, so one bad walk cost every subsequent boot the full walk.
 *
 * It is the direction D49 forbids — a fallible read (a `readdir` over a root
 * that may not be mounted) destroying durable work — and D148 already says the
 * ledger is never cancelled on its own evidence. Two guards, because the live
 * fault would have escaped either one alone: the placement probe had not run
 * yet at walk time, so "the location is flagged unusable" was not yet true.
 */
describe('SegmentHourLedger.reconcileFromIndex — refuses a destructive walk', () => {
  /** `hours` past hours in the ledger, all on `locationId`. */
  async function ledgerWithHours(
    hours: number,
    logger: IScopedLogger,
    locationId = 'recordings',
    isLocationUsable?: (locationId: string) => boolean,
  ): Promise<SegmentHourLedger> {
    const store = fakeStore()
    const ledger = new SegmentHourLedger({
      store,
      logger,
      ...(isLocationUsable ? { isLocationUsable } : {}),
    })
    await ledger.declare()
    for (let i = 1; i <= hours; i += 1) {
      await ledger.recordSegment(row(HOUR0 - i * HOUR_MS + 1_000, 100, 'high', locationId))
    }
    return ledger
  }

  it('keeps every hour when the walk found the root EMPTY, and says so with the delta', async () => {
    const warns: Recorded[] = []
    const ledger = await ledgerWithHours(40, warnRecordingLogger(warns))

    // The walk saw an empty tmpfs: the index holds nothing at all.
    await ledger.reconcileFromIndex(new RecordingIndex(), [99], HOUR0 + 60_000)

    expect(ledger.snapshot()).toHaveLength(40)
    const refused = warns.filter((line) => /refus/i.test(line.message))
    expect(refused).toHaveLength(1)
    const extras = refused[0]?.extras as {
      tags?: { deviceId?: number }
      meta?: { held?: number; onDisk?: number }
    }
    expect(extras.tags).toEqual({ deviceId: 99 })
    expect(extras.meta?.held).toBe(40)
    expect(extras.meta?.onDisk).toBe(0)
  })

  it('keeps the ledger when the location is flagged UNUSABLE, however small the ledger', async () => {
    const warns: Recorded[] = []
    const ledger = await ledgerWithHours(3, warnRecordingLogger(warns), 'recordings', () => false)

    await ledger.reconcileFromIndex(new RecordingIndex(), [99], HOUR0 + 60_000)

    // Three hours is below any magnitude threshold — the volume verdict is what
    // saves it here, and that is the point of having both guards.
    expect(ledger.snapshot()).toHaveLength(3)
    expect(warns.some((line) => /refus/i.test(line.message))).toBe(true)
  })

  it('the previous ledger SURVIVES a respawn onto an empty root', async () => {
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    for (let i = 1; i <= 40; i += 1) {
      await first.recordSegment(row(HOUR0 - i * HOUR_MS + 1_000))
    }

    // A fresh process, a fresh ledger, and a walk that finds nothing.
    const respawned = new SegmentHourLedger({ store, logger: silentLogger() })
    await respawned.declare()
    await respawned.load()
    await respawned.reconcileFromIndex(new RecordingIndex(), [99], HOUR0 + 60_000)

    const third = new SegmentHourLedger({ store, logger: silentLogger() })
    await third.declare()
    // The next boot still takes the incremental path instead of a ~400 s walk.
    expect(await third.load()).toHaveLength(40)
  })

  it('a NORMAL reconcile still prunes, adds and unions', async () => {
    const warns: Recorded[] = []
    const ledger = await ledgerWithHours(40, warnRecordingLogger(warns))

    // The walk agrees about 39 of the 40 hours and finds one the ledger missed.
    const index = new RecordingIndex()
    for (let i = 2; i <= 40; i += 1) index.addSegment(row(HOUR0 - i * HOUR_MS + 1_000))
    const fresh = row(HOUR0 - 99 * HOUR_MS + 1_000)
    index.addSegment(fresh)

    await ledger.reconcileFromIndex(index, [99], HOUR0 + 60_000)

    // The one hour disk no longer has is gone; the new one is in. A guard that
    // refused everything would be no guard, just a broken reconcile.
    const hours = ledger.snapshot().map((h) => h.hourStartMs)
    expect(hours).not.toContain(HOUR0 - HOUR_MS)
    expect(hours).toContain(HOUR0 - 99 * HOUR_MS)
    expect(warns.filter((line) => /refus/i.test(line.message))).toHaveLength(0)
  })

  /**
   * D524 gave the RAM index a residency budget: it drops the (device, hour)
   * buckets nobody asked about, and the reader walks the directory again. That
   * is safe for a READER and catastrophic for this prune — an hour the index
   * dropped looks exactly like an hour disk no longer has, and the ledger row
   * would be forgotten for footage that is still on the array.
   *
   * So a walk during which the index dropped anything for that camera is a
   * walk this ledger does not trust, in the same sense as a walk over an
   * unmounted root: what it FOUND is still unioned in, what it did not find
   * decides nothing.
   */
  it('refuses to prune when the index DROPPED hours during the walk', async () => {
    const warns: Recorded[] = []
    const ledger = await ledgerWithHours(40, warnRecordingLogger(warns))

    const index = new RecordingIndex()
    index.armResidency({
      logger: silentLogger(),
      now: () => HOUR0 + 60_000,
      // 40 rows offered, 28 kept — a 30 % shrink, which sails under the
      // magnitude guard's 50 %. Without this gate those 12 hours would be
      // forgotten durably, for footage still on the array.
      budget: {
        residentRowBudget: 36,
        residentHourBudget: 36,
        evictToFraction: 0.8,
        pinnedTailHours: 2,
      },
    })
    index.beginWalk(99)
    index.hydrateDevice(
      99,
      'recordings',
      Array.from({ length: 40 }, (_, i) => row(HOUR0 - (i + 1) * HOUR_MS + 1_000).path),
    )
    expect(index.droppedDuringWalk(99)).toBe(true)

    await ledger.reconcileFromIndex(index, [99], HOUR0 + 60_000)

    expect(ledger.snapshot()).toHaveLength(40)
    const refused = warns.filter((line) => /the RAM index dropped hours/.test(line.message))
    expect(refused).toHaveLength(1)
    const extras = refused[0]?.extras as { tags?: { deviceId?: number } }
    expect(extras.tags).toEqual({ deviceId: 99 })
    // …and the magnitude guard did NOT fire, so this gate is the only thing
    // standing between the eviction and a durable delete.
    expect(warns.filter((line) => /magnitude|maxShare/.test(line.message))).toHaveLength(0)
  })

  it('a device whose ledger is tiny still prunes — the floor is not a licence to never clean up', async () => {
    const ledger = await ledgerWithHours(3, silentLogger())
    await ledger.reconcileFromIndex(new RecordingIndex(), [99], HOUR0 + 60_000)
    expect(ledger.snapshot()).toHaveLength(0)
  })
})

/**
 * `hourRow` and `forgetHour` — the one-hour surfaces the ghost-location sweep
 * and the walk reconcile act on.
 *
 * They are keyed on the tuple the ledger actually buckets by,
 * `(deviceId, profile, locationId, hour)`, because a caller that FORGETS a row
 * has to name that exact row and nothing coarser.
 *
 * Since D523 `hourRow` is SYNCHRONOUS and cannot fail: the row is the account,
 * the mirror carries all of it, and a read that used to go to the store for the
 * hour's file names has become a directory listing the CALLER does. So the
 * `null`-versus-`[]` safety this block used to carry has moved to
 * {@link HourLister}, and what is left to pin here is that `undefined` means
 * "this ledger holds no such hour" — never "the hour is empty" — and that
 * forgetting one answers with what it was accounting for.
 */
describe('SegmentHourLedger.hourRow / forgetHour', () => {
  it('answers the held row from the mirror after a restart, with no query at all', async () => {
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    const a = row(HOUR0 + 1_000)
    const b = row(HOUR0 + 11_000, 200)
    await first.recordSegment(a)
    await first.recordSegment(b)

    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()

    expect(restarted.hourRow(99, 'high', 'recordings', HOUR0)).toMatchObject({
      deviceId: 99,
      profile: 'high',
      locationId: 'recordings',
      hourStartMs: HOUR0,
      segments: 2,
      bytes: 300,
    })
  })

  it('answers undefined for an hour it does not hold — on every part of the key', async () => {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000))

    expect(ledger.hourRow(99, 'high', 'recordings', HOUR0 - HOUR_MS)).toBeUndefined()
    expect(ledger.hourRow(99, 'low', 'recordings', HOUR0)).toBeUndefined()
    expect(ledger.hourRow(99, 'high', 'recordings:gone', HOUR0)).toBeUndefined()
    expect(ledger.hourRow(98, 'high', 'recordings', HOUR0)).toBeUndefined()
    expect(ledger.hourRow(99, 'high', 'recordings', HOUR0)).toBeDefined()
  })

  it('a store that is DOWN changes neither answer — the mirror is RAM (D49)', async () => {
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    await first.recordSegment(row(HOUR0 + 1_000))

    let failReads = false
    const flaky: SettingsStoreClient = {
      ...store,
      query: {
        query: (input: Parameters<typeof store.query.query>[0]) => {
          if (failReads) return Promise.reject(new Error('store unavailable'))
          return store.query.query(input)
        },
      },
    }

    const restarted = new SegmentHourLedger({ store: flaky, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()
    failReads = true

    // No point read exists on this path any more, so there is nothing for a
    // dead store to break: the hour is still held and still reports its row.
    expect(restarted.knowsHour(99, 'high', 'recordings', HOUR0)).toBe(true)
    expect(restarted.hourRow(99, 'high', 'recordings', HOUR0)?.segments).toBe(1)
  })

  it('forgetHour answers the segments it stopped accounting for, and 0 for an hour it never held', async () => {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000))
    await ledger.recordSegment(row(HOUR0 + 11_000, 200))

    // The caller arrives with a verdict, not with evidence — `forgetHour` makes
    // no check of its own and can make none. What it owes back is the number
    // the operator is shown.
    expect(await ledger.forgetHour(99, 'high', 'recordings', HOUR0 - HOUR_MS)).toBe(0)
    expect(await ledger.forgetHour(99, 'high', 'recordings', HOUR0)).toBe(2)
    expect(ledger.hourRow(99, 'high', 'recordings', HOUR0)).toBeUndefined()
    expect(ledger.snapshot()).toEqual([])
    // Forgetting twice is not forgetting twice as much.
    expect(await ledger.forgetHour(99, 'high', 'recordings', HOUR0)).toBe(0)
  })
})

/**
 * `forgetScope` — the durable half of an operator's "discard this location's
 * footage", and the one surface here that deletes rows with no evidence from
 * the array at all.
 *
 * It exists because the discard job wipes the class subtrees FIRST: by the time
 * the ledger is touched every hour directory in the scope is gone, so nothing
 * can name a segment (D523) and a pass that walked the segments to forget them
 * would forget nothing and leave the whole location accounted for on every
 * storage page, forever. The operator's own armed instruction is the evidence.
 *
 * Run against the REAL ledger. `location-discard-job.spec.ts` hands the job a
 * spy, which is the right shape for pinning what the job CALLS — and a spy
 * stayed green when the real `forgetScope` was made to forget nothing.
 */
describe('SegmentHourLedger.forgetScope — the armed discard', () => {
  async function seeded(): Promise<SegmentHourLedger> {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000, 100, 'low', 'recordingsLow', 104))
    await ledger.recordSegment(row(HOUR0 + 11_000, 200, 'low', 'recordingsLow', 104))
    // Another hour of the same (camera, profile, location): a scope is not one row.
    await ledger.recordSegment(row(HOUR0 + HOUR_MS + 1_000, 300, 'low', 'recordingsLow', 104))
    // A profile the discard of a `recordingsLow` class does NOT cover…
    await ledger.recordSegment(row(HOUR0 + 2_000, 400, 'high', 'recordingsLow', 104))
    // …and the same camera's footage on a location that is staying.
    await ledger.recordSegment(row(HOUR0 + 3_000, 500, 'low', 'recordingsKeep', 104))
    return ledger
  }

  it('forgets every row of the scope and answers the SEGMENTS it stopped accounting for', async () => {
    const ledger = await seeded()

    expect(await ledger.forgetScope({ locationId: 'recordingsLow', profiles: ['low'] })).toBe(3)

    expect(ledger.hourRow(104, 'low', 'recordingsLow', HOUR0)).toBeUndefined()
    expect(ledger.hourRow(104, 'low', 'recordingsLow', HOUR0 + HOUR_MS)).toBeUndefined()
    // The number the operator is shown is SEGMENTS, not hour rows: two rows
    // went and three segments' worth of accounting went with them.
    expect(ledger.usageByDevice(new Set(['recordingsLow'])).get(104)).toMatchObject({
      segments: 1,
      bytes: 400,
    })
  })

  it('leaves every row OUTSIDE the scope exactly where it was', async () => {
    const ledger = await seeded()
    await ledger.forgetScope({ locationId: 'recordingsLow', profiles: ['low'] })

    // The other profile on the discarded location, and the other location.
    expect(ledger.hourRow(104, 'high', 'recordingsLow', HOUR0)?.segments).toBe(1)
    expect(ledger.hourRow(104, 'low', 'recordingsKeep', HOUR0)?.segments).toBe(1)
    expect(ledger.snapshot()).toHaveLength(2)
  })

  it('survives a restart — the rows are gone from the STORE, not just the mirror', async () => {
    const { ledger, store } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000, 100, 'low', 'recordingsLow', 104))
    await ledger.recordSegment(row(HOUR0 + 2_000, 400, 'high', 'recordingsLow', 104))
    await ledger.forgetScope({ locationId: 'recordingsLow', profiles: ['low'] })

    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()

    // A forget that only emptied RAM would come back on the next boot and the
    // operator's discard would look like it had not happened.
    expect(restarted.snapshot().map((r) => r.profile)).toEqual(['high'])
  })

  it('forgets NOTHING for a scope the ledger holds no row for', async () => {
    const ledger = await seeded()
    expect(await ledger.forgetScope({ locationId: 'recordingsGone' })).toBe(0)
    // Four ROWS: the two `low` segments of HOUR0 share one.
    expect(ledger.snapshot()).toHaveLength(4)
  })
})

/**
 * `usageByDevice` is the per-camera half of the storage page (D418) — the read
 * that replaced `RecordingIndex.accounting(deviceId)` there, and the absence of
 * which let a 1.9 TB archive report 60.5 GB.
 */
describe('SegmentHourLedger.usageByDevice — the ARCHIVE, per camera', () => {
  it('sums bytes and segments per camera and carries the oldest archived start', async () => {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000, 100, 'high', 'recordings', 101))
    // A second hour of the same camera: the fold has to cross hour rows.
    await ledger.recordSegment(row(HOUR0 + 3_600_000 + 5_000, 300, 'high', 'recordings', 101))
    // A second profile of the same camera, on the same disk.
    await ledger.recordSegment(row(HOUR0 + 2_000, 50, 'low', 'recordings', 101))
    await ledger.recordSegment(row(HOUR0 + 9_000, 700, 'high', 'recordings', 102))

    const usage = ledger.usageByDevice(new Set(['recordings']))
    expect(usage.get(101)).toEqual({
      bytes: 450,
      segments: 3,
      oldestMs: HOUR0 + 1_000,
      newestMs: HOUR0 + 3_600_000 + 5_000,
    })
    expect(usage.get(102)?.bytes).toBe(700)
  })

  it('counts only the locations it was asked about, and refuses an empty set', async () => {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000, 100, 'high', 'recordings', 101))
    await ledger.recordSegment(row(HOUR0 + 2_000, 900, 'high', 'recordings:ghost', 101))

    // Footage stranded on a location id nobody resolves stays invisible — the
    // storage page must never show bytes no volume row accounts for.
    expect(ledger.usageByDevice(new Set(['recordings'])).get(101)?.bytes).toBe(100)
    expect(ledger.usageByDevice(new Set()).size).toBe(0)
  })
})

describe('SegmentHourLedger — the archive floor the calendar clamps to (D674)', () => {
  it('is not an answer until a load has answered', async () => {
    const { ledger, store } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 1_000, 100, 'low', 'recordingsLow', 104))
    // Written this boot, but nothing was LOADED: the mirror may be a fraction.
    expect(ledger.hasLoaded()).toBe(false)
    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()
    expect(restarted.hasLoaded()).toBe(true)
  })

  it('folds the OLDEST hour per camera across every profile and location', async () => {
    const { ledger } = await openLedger()
    await ledger.recordSegment(row(HOUR0 + 5 * HOUR_MS + 1_000, 100, 'high', 'recordings', 104))
    await ledger.recordSegment(row(HOUR0 + 2 * HOUR_MS + 1_000, 100, 'low', 'recordingsLow', 104))
    await ledger.recordSegment(row(HOUR0 + 9 * HOUR_MS + 1_000, 100, 'high', 'recordings', 101))
    const floors = ledger.oldestHourByDevice()
    expect(floors.get(104)).toBe(HOUR0 + 2 * HOUR_MS)
    expect(floors.get(101)).toBe(HOUR0 + 9 * HOUR_MS)
    expect(floors.has(102)).toBe(false)
  })
})

describe('SegmentHourLedger — a load is an answer only when WHOLE (D674 review C1/H1/M2)', () => {
  /** A store holding `n` hour rows for camera 104, one per hour. */
  async function storeWithRows(n: number): Promise<SettingsStoreClient> {
    const store = fakeStore()
    const { ledger } = await openLedger(store)
    for (let i = 0; i < n; i++) {
      await ledger.recordSegment(row(HOUR0 + i * HOUR_MS + 1_000, 100, 'low', 'recordings', 104))
    }
    return store
  }

  it('is NOT loaded while chunks are still staging — a partial mirror is never an answer', async () => {
    const store = await storeWithRows(12)
    const seenMidLoad: boolean[] = []
    const ledger: SegmentHourLedger = new SegmentHourLedger({
      store,
      logger: silentLogger(),
      loadPacing: {
        chunkSize: 5,
        yieldBetween: async () => {
          seenMidLoad.push(ledger.hasLoaded(), ledger.isComplete())
        },
      },
    })
    await ledger.declare()
    await ledger.load()
    expect(seenMidLoad.length).toBeGreaterThan(0)
    expect(seenMidLoad.every((v) => v === false)).toBe(true)
    expect(ledger.hasLoaded()).toBe(true)
    expect(ledger.isComplete()).toBe(true)
  })

  it('a load cut at its row cap is loaded but NOT complete, and asks newest-first', async () => {
    const store = await storeWithRows(6)
    const asked: unknown[] = []
    const query = store.query.query.bind(store.query)
    const spied = {
      ...store,
      query: {
        query: (input: Parameters<typeof query>[0]) => {
          asked.push(input.filter)
          return query(input)
        },
      },
    } as unknown as SettingsStoreClient
    const ledger = new SegmentHourLedger({
      store: spied,
      logger: silentLogger(),
      loadPacing: { rowCap: 4 },
    })
    await ledger.declare()
    await ledger.load()
    expect(ledger.hasLoaded()).toBe(true)
    expect(ledger.isComplete()).toBe(false)
    expect(asked[0]).toMatchObject({
      limit: 4,
      orderBy: { field: 'hourStartMs', direction: 'desc' },
    })
  })

  it('retries a FAILED load — bounded, spaced, and says when it gives up', async () => {
    const store = await storeWithRows(2)
    let failures = 3
    let t = 0
    const warns: Recorded[] = []
    const query = store.query.query.bind(store.query)
    const flaky = {
      ...store,
      query: {
        query: (input: Parameters<typeof query>[0]) => {
          if (failures > 0) {
            failures -= 1
            return Promise.reject(new Error('store down'))
          }
          return query(input)
        },
      },
    } as unknown as SettingsStoreClient
    const ledger = new SegmentHourLedger({
      store: flaky,
      logger: warnRecordingLogger(warns),
      now: () => t,
    })
    await ledger.declare()
    await ledger.load()
    expect(ledger.hasLoaded()).toBe(false)
    // Too soon: no second attempt.
    ledger.retryLoadIfUnanswered()
    await Promise.resolve()
    expect(failures).toBe(2)
    for (let i = 0; i < 3; i++) {
      t += LEDGER_LOAD_RETRY_MS
      ledger.retryLoadIfUnanswered()
      await ledger.load()
    }
    expect(ledger.hasLoaded()).toBe(true)
    expect(ledger.snapshot()).toHaveLength(2)
  })

  it('after LEDGER_LOAD_MAX_ATTEMPTS it SLOWS, never stops — said once', async () => {
    const warns: Recorded[] = []
    let t = 0
    let attempts = 0
    const dead = {
      ...fakeStore(),
      query: {
        query: () => {
          attempts += 1
          return Promise.reject(new Error('store down'))
        },
      },
    } as unknown as SettingsStoreClient
    const ledger = new SegmentHourLedger({
      store: dead,
      logger: warnRecordingLogger(warns),
      now: () => t,
    })
    await ledger.load()
    for (let i = 0; i < LEDGER_LOAD_MAX_ATTEMPTS + 5; i++) {
      t += LEDGER_LOAD_RETRY_MS
      ledger.retryLoadIfUnanswered()
      await new Promise((r) => setTimeout(r, 0))
    }
    // Fast attempts only: the extra minute-spaced asks are refused.
    expect(attempts).toBe(LEDGER_LOAD_MAX_ATTEMPTS)
    // …and one more per slow interval, for as long as it takes.
    for (let i = 0; i < 3; i++) {
      t += LEDGER_LOAD_SLOW_RETRY_MS
      ledger.retryLoadIfUnanswered()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(attempts).toBe(LEDGER_LOAD_MAX_ATTEMPTS + 3)
    expect(warns.filter((w) => w.message.includes('slow interval'))).toHaveLength(1)
  })

  it('a retry never overwrites a row this process already wrote', async () => {
    const store = await storeWithRows(1)
    let failFirst = true
    const query = store.query.query.bind(store.query)
    const flaky = {
      ...store,
      query: {
        query: (input: Parameters<typeof query>[0]) => {
          if (failFirst) {
            failFirst = false
            return Promise.reject(new Error('store down'))
          }
          return query(input)
        },
      },
    } as unknown as SettingsStoreClient
    let t = 0
    const ledger = new SegmentHourLedger({ store: flaky, logger: silentLogger(), now: () => t })
    await ledger.load()
    // What the retry's query will return for hour 0 — read BEFORE the writer's
    // put lands (the race the guard exists for).
    const stale = (await query({ collection: RECORDING_SEGMENT_HOURS_COLLECTION }))[0]!
    // The writer appends to hour 0 after the failed load…
    await ledger.recordSegment(row(HOUR0 + 2_000, 100, 'low', 'recordings', 104))
    const held = ledger.hourRow(104, 'low', 'recordings', HOUR0)
    // …and the store still answers the stale row.
    await store.set.mutate({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      key: stale.id,
      value: stale.data,
    })
    expect(held?.minStartMs).not.toBe(
      (await query({ collection: RECORDING_SEGMENT_HOURS_COLLECTION }))[0]?.data['minStartMs'],
    )
    t += LEDGER_LOAD_RETRY_MS
    ledger.retryLoadIfUnanswered()
    await ledger.load()
    expect(ledger.hourRow(104, 'low', 'recordings', HOUR0)).toEqual(held)
  })
})
