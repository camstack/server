/**
 * WHO may write a seal (D521).
 *
 * D451 made an hour's row say whether it had been SEALED, and closed with the
 * one thing it could not enforce: "nothing catches a future `sealed: true`
 * written by a party that cannot know the hour is complete". The rollover seal
 * it shipped IS that party.
 *
 * Camera 101, 2026-09-17: the recorder runner respawned mid-hour; the watcher
 * of the new process found ffmpeg's playlist truncated and reported
 * `rolledOff=175, processed=0`, so 175 finalizes never reached `recordSegment`.
 * The respawned writer's FIRST finalize into H created the row without them,
 * and at the H→H+1 rollover it sealed H — a claim of completeness about the
 * 29 minutes it was not there for. Sealed ⇒ hydrate marks the hour hydrated ⇒
 * `hourSegmentsFromIndex` answers non-null ⇒ `segmentsOfChecked` reports
 * `complete: true` and never readdirs ⇒ the closed-hour skip in `roots.ts` is
 * bypassed only for UNSEALED hours. Two hours of footage sat intact on the
 * array, invisible to every reader, for the life of the footage.
 *
 * The rule: a seal is a CLAIM OF COMPLETENESS, and only a party that could know
 * the hour is complete may write one. A writer knows its own hour only from the
 * moment it entered it.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import {
  RECORDING_SEGMENT_HOURS_COLLECTION,
  SegmentHourLedger,
  WRITER_HOUR_ENTRY_GRACE_MS,
  segmentHourKey,
} from '../segment-hour-ledger.js'
import { type FakeSettingsStore, fakeSettingsStore } from './fixtures/fake-settings-store.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 101
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

function row(fake: FakeSettingsStore, hour: number): Record<string, unknown> | undefined {
  const key = segmentHourKey(DEVICE, PROFILE, LOCATION, hour)
  return fake.rows(RECORDING_SEGMENT_HOURS_COLLECTION).find((r) => r.id === key)?.data
}

/** A ledger with nothing behind it — the respawned process's own view. */
function fresh(fake: FakeSettingsStore): SegmentHourLedger {
  return new SegmentHourLedger({ store: fake.store, logger: silent() })
}

describe('a writer seals only an hour it was present for from the start', () => {
  it('refuses to seal an hour it entered MIDWAY (camera 101, 2026-09-17)', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    // The respawned writer's first finalize lands 29 minutes into the hour —
    // the 175 segments before it were rolled past by its predecessor and never
    // reached this ledger. This process cannot know what H holds.
    await ledger.recordSegment(segment(HOUR0 + 29 * 60_000))
    await ledger.recordSegment(segment(HOUR0 + 29 * 60_000 + 10_000))
    // The rollover into H+1 is where the seal used to be written.
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
    // The hour is still WRITTEN — the refusal is about the claim, not about the
    // footage this process did record.
    expect(row(fake, HOUR0)?.['segments']).toBe(2)
  })

  it('still seals an hour it was in from the start — the rollover seal survives', async () => {
    // The control. Without it the test above passes for a ledger that seals
    // nothing at all, which is D451's cost undone.
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    for (let s = 0; s < 6; s += 1) await ledger.recordSegment(segment(HOUR0 + s * 10_000))
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(1)
  })

  it('takes the grace from the FIRST finalize into the hour, not the last', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    // Entered inside the grace, then recorded for the rest of the hour: the
    // hour is owned, and every later finalize must not re-open the question.
    await ledger.recordSegment(segment(HOUR0 + WRITER_HOUR_ENTRY_GRACE_MS))
    await ledger.recordSegment(segment(HOUR0 + 50 * 60_000))
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(1)
  })

  it('refuses one millisecond past the grace', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    await ledger.recordSegment(segment(HOUR0 + WRITER_HOUR_ENTRY_GRACE_MS + 1))
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
  })

  it('refuses on a GRACEFUL stop too — a clean exit is not knowledge of the hour', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    await ledger.recordSegment(segment(HOUR0 + 20 * 60_000))
    await ledger.sealWriter(DEVICE, PROFILE)
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
  })

  it('seals on a graceful stop of a writer that owned its hour', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    await ledger.recordSegment(segment(HOUR0 + 10_000))
    await ledger.sealWriter(DEVICE, PROFILE)
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(1)
  })
})

describe('a loss the WATCHER reported keeps the hour unsealed', () => {
  it('refuses the seal for every hour a reported loss spans', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    // This writer DID enter the hour at its start, so the ownership gate alone
    // would let it seal. The playlist rolled past 175 entries in the middle of
    // the hour: the loss is the only evidence that the row is short.
    await ledger.recordSegment(segment(HOUR0))
    const marked = ledger.markHoursRefused({
      deviceId: DEVICE,
      profile: PROFILE,
      fromMs: HOUR0 + 20 * 60_000,
      toMs: HOUR0 + 40 * 60_000,
      count: 175,
    })
    await ledger.recordSegment(segment(HOUR0 + 50 * 60_000))
    await ledger.recordSegment(segment(HOUR0 + HOUR_MS))
    await ledger.flush()

    expect(marked).toBe(1)
    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
  })

  it('marks every hour the loss spans, and only those', async () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)
    await ledger.declare()

    const marked = ledger.markHoursRefused({
      deviceId: DEVICE,
      profile: PROFILE,
      fromMs: HOUR0 + 30 * 60_000,
      toMs: HOUR0 + HOUR_MS + 30 * 60_000,
      count: 9,
    })
    expect(marked).toBe(2)

    // One writer walking four hours in order: the two the loss spans refuse,
    // and the one AFTER it seals. A refusal that widened itself would cost a
    // directory read per hour of the archive, forever.
    for (let h = 0; h <= 3; h += 1) await ledger.recordSegment(segment(HOUR0 + h * HOUR_MS))
    await ledger.flush()

    expect(row(fake, HOUR0)?.['sealed']).toBe(0)
    expect(row(fake, HOUR0 + HOUR_MS)?.['sealed']).toBe(0)
    expect(row(fake, HOUR0 + 2 * HOUR_MS)?.['sealed']).toBe(1)
  })

  it('is bounded: a nonsense span cannot mark the whole archive unsealed', () => {
    const fake = fakeSettingsStore()
    const ledger = fresh(fake)

    const marked = ledger.markHoursRefused({
      deviceId: DEVICE,
      profile: PROFILE,
      fromMs: HOUR0 - 400 * HOUR_MS,
      toMs: HOUR0,
      count: 4,
    })
    expect(marked).toBeLessThanOrEqual(24)
  })
})
