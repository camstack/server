/**
 * The SEAL: does a row say whether it describes its whole hour? (D451)
 *
 * WHY THIS FILE EXISTS. D445 fixed the SYMPTOM — an export walks its window
 * verified, finds the segments the ledger forgot, and serves the right
 * calendar. On camera 4374 that produced `forgottenSegments=9758
 * forgottenHours=5`. But every burst makes a new one, because the row is
 * written write-behind per finalized segment and a writer torn down mid-hour
 * leaves an hour nobody will ever describe again. Nothing distinguishes "this
 * row is the hour" from "this row is what we had persisted when the writer
 * died".
 *
 * THE DEFECT THIS FILE FOUND FIRST. D445 records that its repair is durable
 * ("the TIMELINE gets the corrected answer too, as a side effect of someone
 * having exported") and `roots.ts` states in a comment that `knowsHour`
 * "deliberately does NOT gate this". Both are false against the real ledger:
 * `adoptRebuiltHour` opens with `if (paths.length === 0 || this.ledger.has(key))
 * return`, so the one row that needs repairing — a row known INCOMPLETELY — is
 * exactly the row it refuses. `hydrate-window-ledger-incomplete.spec.ts` is
 * green over it because its `stubLedger` fake records every call unconditionally;
 * the fake supplied the behaviour production declines. That is the second time
 * this repo has shipped that exact trap.
 *
 * So the first test here is written against the REAL `SegmentHourLedger`, and
 * it is the one that must go red without the fix.
 *
 * ## What D523 changed here, and what it bought
 *
 * The seal itself is untouched: who may write one, that an unsealed row is a
 * legitimate readable answer, and that it costs ONE write per hour rather than
 * one per segment. What changed is the WALK.
 *
 * D148 said a walk may only ADD — a path the row named and the array no longer
 * showed survived, because "the reader did not see it" was not evidence it was
 * gone. That rule was affordable only while the row NAMED its paths. D523 took
 * the `paths` column away and made the DIRECTORY the authority for which
 * segments exist, so there is nothing left to union: `adoptWalkedHour` now
 * REPLACES the hour's account with the listing's, downwards included. What that
 * bought is an over-counted hour — a duplicate finalize across a restart, an
 * arithmetic shrink from eviction — correcting itself the first time anything
 * walks it, which the union could never do.
 *
 * What replaced D148's protection is narrower and lives in the same place: a
 * listing that would erase more than {@link HOUR_LISTING_MAX_SHRINK_SHARE} of
 * what the row accounts for is REFUSED, the row stands, the hour stays
 * unsealed, and the disagreement is named. An unmounted root and a bucket a
 * dead round half-deleted both answer SHORT; an hour that merely shrank is the
 * ordinary result of eviction, and it is adopted.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import {
  HOUR_LISTING_MAX_SHRINK_SHARE,
  RECORDING_SEGMENT_HOURS_COLLECTION,
  SegmentHourLedger,
  type SegmentHourRow,
  segmentHourKey,
} from '../segment-hour-ledger.js'
import { type FakeSettingsStore, fakeSettingsStore } from './fixtures/fake-settings-store.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 4374
const PROFILE = 'low'
const LOCATION = 'recordingsLow:default'

function silent(): IScopedLogger {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function segment(startMs: number): SegmentRow {
  return {
    deviceId: DEVICE,
    profile: PROFILE,
    startMs,
    durMs: 10_000,
    bytes: 120_000,
    path: segmentRelPath(DEVICE, PROFILE, startMs, 10_000, 120_000),
    locationId: LOCATION,
  }
}

/** The paths a burst of `n` segments starting at `HOUR0` puts on the array. */
function burst(n: number, from = 0): readonly string[] {
  return Array.from({ length: n }, (_, i) => segment(HOUR0 + (from + i) * 10_000).path)
}

/** The stored row for one hour key, as the store holds it. */
function row(fake: FakeSettingsStore, hour: number): Record<string, unknown> | undefined {
  const key = segmentHourKey(DEVICE, PROFILE, LOCATION, hour)
  return fake.rows(RECORDING_SEGMENT_HOURS_COLLECTION).find((r) => r.id === key)?.data
}

/** One log line, as the ledger emitted it. */
interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly extras: LogExtras | undefined
}

function capturing(sink: CapturedLine[]): IScopedLogger {
  const at =
    (level: CapturedLine['level']) =>
    (msg: string, extras?: LogExtras): void => {
      sink.push({ level, msg, extras })
    }
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

/** A ledger whose clock is well past HOUR0, so HOUR0 is CLOSED. */
function open(fake: FakeSettingsStore, logger: IScopedLogger = silent()): SegmentHourLedger {
  return new SegmentHourLedger({
    store: fake.store,
    logger,
    now: () => HOUR0 + 10 * HOUR_MS,
  })
}

/** The hour's account as the ledger holds it — since D523 a row carries
 *  everything it has, so this is the whole answer about HOUR0. */
function held(ledger: SegmentHourLedger): SegmentHourRow | undefined {
  return ledger.hourRow(DEVICE, PROFILE, LOCATION, HOUR0)
}

/**
 * The robot's hour as the writer actually left it: a burst of 40 segments
 * reached the array, the ledger was handed the first 4 before the writer was
 * torn down, and the hour then went cold.
 */
async function tornWriter(): Promise<FakeSettingsStore> {
  const fake = fakeSettingsStore()
  const writer = new SegmentHourLedger({ store: fake.store, logger: silent() })
  await writer.declare()
  for (let s = 0; s < 4; s += 1) await writer.recordSegment(segment(HOUR0 + s * 10_000))
  return fake
}

describe('a walk of a CLOSED hour repairs the durable row', () => {
  it('takes the listing as the hour account of a row the ledger knows SHORT', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    // The precondition: the ledger holds the hour, and holds it short.
    expect(ledger.knowsHour(DEVICE, PROFILE, LOCATION, HOUR0)).toBe(true)
    expect(held(ledger)?.segments).toBe(4)

    await ledger.adoptWalkedHour(DEVICE, PROFILE, LOCATION, HOUR0, burst(40))

    // D445's own consequence — "the TIMELINE gets the corrected answer too" —
    // as an assertion against the REAL ledger rather than against a spy. The
    // row, and the durable row behind it, now account for the 40 the DIRECTORY
    // holds, not the 4 the dying writer managed to persist.
    expect(held(ledger)?.segments).toBe(40)
    expect(held(ledger)?.bytes).toBe(40 * 120_000)
    expect(row(fake, HOUR0)?.['segments']).toBe(40)
  })

  /**
   * D148's "a walk only ADDS" is GONE here, deliberately — see the file
   * header. The directory decides which segments exist, so a smaller listing
   * shrinks the row. What is left in its place is a magnitude bar, and it is
   * the same argument `LEDGER_PRUNE_MAX_SHARE` makes one level up: an
   * unmounted root and a bucket a dead round half-deleted both answer SHORT,
   * and a short answer that halves an hour is indistinguishable from one that
   * is simply right.
   */
  it('REFUSES a listing that would erase more than half the hour, and SAYS so', async () => {
    const fake = await tornWriter()
    const lines: CapturedLine[] = []
    const ledger = open(fake, capturing(lines))
    await ledger.declare()
    await ledger.load()
    expect(held(ledger)?.segments).toBe(4)

    // One segment where the row accounts for four: 75% erased, over the bar.
    const outcome = await ledger.adoptWalkedHour(DEVICE, PROFILE, LOCATION, HOUR0, burst(1))

    // The row STANDS, and it stays unsealed — a listing this ledger refused is
    // not a party that may claim the hour is complete.
    expect(outcome).toEqual({ created: false, added: 0, sealedNow: false })
    expect(held(ledger)?.segments).toBe(4)
    expect(row(fake, HOUR0)?.['segments']).toBe(4)
    expect(held(ledger)?.sealed).toBe(false)

    // And it is NAMED, per camera: a refusal nobody can attribute to a camera
    // cannot answer "why is 4374 short?".
    const refusal = lines.find((l) => l.msg.includes('hour listing REFUSED'))
    expect(refusal?.level).toBe('warn')
    expect(refusal?.extras?.tags).toEqual({ deviceId: DEVICE })
    expect(refusal?.extras?.meta).toMatchObject({
      held: 4,
      listed: 1,
      maxShare: HOUR_LISTING_MAX_SHRINK_SHARE,
      hourStartMs: HOUR0,
      profile: PROFILE,
      locationId: LOCATION,
    })
  })

  it('ADOPTS a listing that erases less than that — an hour that shrank is ordinary', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    // Three where the row held four: eviction took one, which is what
    // retention does every hour of every day. Under the bar, so the directory
    // wins and the corrected account is sealed.
    await ledger.adoptWalkedHour(DEVICE, PROFILE, LOCATION, HOUR0, burst(3, 1))

    expect(held(ledger)?.segments).toBe(3)
    expect(held(ledger)?.minStartMs).toBe(HOUR0 + 10_000)
    expect(held(ledger)?.sealed).toBe(true)
    expect(row(fake, HOUR0)?.['segments']).toBe(3)
  })

  it('adopts an hour the ledger never held at all, as it always did', async () => {
    const fake = fakeSettingsStore()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    await ledger.adoptWalkedHour(DEVICE, PROFILE, LOCATION, HOUR0, burst(12))

    expect(held(ledger)?.segments).toBe(12)
  })
})

describe('an UNSEALED hour is a legitimate, readable answer', () => {
  it('a row a torn writer left reads unsealed — never an error', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    const hour = held(ledger)
    // Not an absence, not a throw: an answer that says what it is worth.
    expect(hour).toBeDefined()
    expect(hour?.segments).toBe(4)
    expect(hour?.sealed).toBe(false)
  })

  it('a row written before the column existed reads unsealed', async () => {
    // The direction that costs one directory read, never a missing hour.
    const fake = await tornWriter()
    const before = row(fake, HOUR0)
    expect(before).toBeDefined()
    delete before?.['sealed']

    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    expect(held(ledger)?.sealed).toBe(false)
  })

  it('a walk of a closed hour SEALS it — a readdir is the one complete answer', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    await ledger.adoptWalkedHour(DEVICE, PROFILE, LOCATION, HOUR0, burst(40))

    expect(held(ledger)?.sealed).toBe(true)
  })
})

describe('the seal costs ONE write per hour, not one per segment', () => {
  it('a writer crossing into the next hour seals the one it left', async () => {
    const fake = fakeSettingsStore()
    const ledger = new SegmentHourLedger({ store: fake.store, logger: silent() })
    await ledger.declare()

    for (let s = 0; s < 6; s += 1) await ledger.recordSegment(segment(HOUR0 + s * 10_000))
    // The first finalize of the NEXT hour is what tells us the previous one is
    // over. No timer, no clock poll, no write per segment.
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    const sealed = row(fake, HOUR0)
    expect(sealed?.['sealed']).toBe(1)
    // And the hour the writer is still IN is not sealed by its own first write.
    const live = row(fake, HOUR0 + HOUR_MS)
    expect(live?.['sealed']).toBe(0)
  })

  it('costs one write beyond the appends — not one per segment', async () => {
    const fake = fakeSettingsStore()
    const ledger = new SegmentHourLedger({ store: fake.store, logger: silent() })
    await ledger.declare()

    for (let s = 0; s < 30; s += 1) await ledger.recordSegment(segment(HOUR0 + s * 10_000))
    const appends = fake.writes.length
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    // 30 appends, then: the next hour's first row, plus ONE seal. The
    // write-behind exists for a reason and the seal must not undo it.
    expect(fake.writes.length - appends).toBe(2)
  })

  it('a late finalize into an older hour seals nothing', async () => {
    const fake = fakeSettingsStore()
    const ledger = new SegmentHourLedger({ store: fake.store, logger: silent() })
    await ledger.declare()

    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    // A recovered orphan landing in the hour before: that hour is already
    // accounted for and going BACKWARDS is not a writer leaving an hour.
    await ledger.recordSegment(segment(HOUR0))
    await ledger.flush()

    const live = row(fake, HOUR0 + HOUR_MS)
    expect(live?.['sealed']).toBe(0)
  })
})

/**
 * The seal is fired WITHOUT being awaited on the rollover, so it races the
 * appends it must not land on top of, and a late finalize races both. Whatever
 * the mechanism underneath, the property these two cases pin is the outcome:
 * **two writes to one hour both survive, in RAM and in the store.**
 *
 * ## What the lane is for NOW, stated honestly (D523)
 *
 * Neither case below goes red with `serialized` removed, and saying otherwise
 * would be this file vouching for something it does not test. Before D523 the
 * first one did: an append had to FETCH the hour's `paths` before it could
 * extend them, so "read, fold, write" had an await in the middle, two runs
 * interleaved and the second wrote an array that never saw the first. The
 * column is gone; the mirror carries the whole row and `DurableLedger.put`
 * advances it synchronously before it awaits the store, so there is no window
 * left between the read and the update for a second run to slip into.
 *
 * What the lane still buys is the ORDER of the durable writes per hour key —
 * two unserialised `put`s on one key reach the store concurrently and the older
 * aggregate can land last — and it is what `flush()` awaits at shutdown. Both
 * of those need a store whose latency a test can control, which this fake does
 * not have; pinning them belongs with the write-behind, not here.
 */
describe('two writes to one hour never lose each other', () => {
  it('keeps both appends when two to the same hour overlap', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    await Promise.all([
      ledger.recordSegment(segment(HOUR0 + 4 * 10_000)),
      ledger.recordSegment(segment(HOUR0 + 5 * 10_000)),
    ])
    await ledger.flush()

    // 4 the torn writer left, plus both of these — and the durable row agrees
    // with the mirror, which is the half a lost write-behind would take.
    expect(held(ledger)?.segments).toBe(6)
    expect(row(fake, HOUR0)?.['segments']).toBe(6)
  })

  /**
   * A writer crossing into the next hour at the same moment a late finalize
   * lands in the one it left. This REOPENED ledger never saw HOUR0's writer, so
   * no seal actually fires here (going backwards seals nothing, and there is no
   * remembered writer to seal forward from) — what is pinned is that the two
   * hour rows do not write over each other.
   */
  it('a rollover seal and a late finalize both survive', async () => {
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    await Promise.all([
      ledger.recordSegment(segment(HOUR0 + HOUR_MS)),
      ledger.recordSegment(segment(HOUR0 + 4 * 10_000)),
    ])
    await ledger.flush()

    expect(held(ledger)?.segments).toBe(5)
    expect(row(fake, HOUR0)?.['segments']).toBe(5)
  })
})

describe('a process that LOST a finalize never seals the hour it lost it in', () => {
  it('leaves the hour unsealed so a reader walks it', async () => {
    // Since D523 the write path reads NOTHING — the mirror carries the whole
    // row — so a finalize is lost only one way: the recorder's bounded
    // write-behind lane refuses to take it, and the recorder says so with
    // `markRefused`. That is the ONE moment this process knows its row is
    // short by a segment nobody else will ever report.
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()

    const lost = segment(HOUR0 + 4 * 10_000)
    ledger.markRefused(lost)

    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
  })

  it('still seals an hour whose every finalize LANDED', async () => {
    // The control: same reopened shape, same rollover, no lost read. Without
    // it the test above passes for a ledger that never seals anything.
    const fake = await tornWriter()
    const ledger = open(fake)
    await ledger.declare()
    await ledger.load()
    await ledger.recordSegment(segment(HOUR0 + 4 * 10_000))
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(1)
  })
})
