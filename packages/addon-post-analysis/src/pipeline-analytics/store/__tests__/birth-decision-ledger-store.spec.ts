/**
 * The birth-decision LEDGER (D409) — the durable measurement of what the
 * confirmation gate decides, and how late a track starts.
 *
 * What is pinned here is the storage contract, because the whole point of the
 * table is that a number read out of it days later is trustworthy:
 *
 *  - a row survives its track (a SUPPRESSED birth never had one at all);
 *  - the append is BEST-EFFORT — a measurement must never fail a birth;
 *  - the table is BOUNDED by row count, oldest evicted first;
 *  - the read path answers newest-first, filtered per camera / verdict / since.
 */
import { MAX_BIRTH_DECISION_RECORDS } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeRecords,
  type InstrumentedRecords,
  instrumentRecords,
  kindRows,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { wireBirthDecisionLedger } from '../event-ledger-wiring.js'
import type { BirthDecisionRecordDraft } from '../../pipeline/birth-decision-record.js'
import { BirthDecisionLedgerStore } from '../birth-decision-ledger-store.js'

const draft = (over: Partial<BirthDecisionRecordDraft> = {}): BirthDecisionRecordDraft => ({
  at: 1_700_000_000_000,
  deviceId: 102,
  sourceTrackId: 'trk-1',
  className: 'person',
  verdict: 'confirmed',
  reason: 'confirmed',
  attempts: 0,
  deferredForMs: 0,
  decidedOnCoastedFrame: false,
  birthEvidenceAvailable: true,
  decidedByBirthEvidence: true,
  bestScore: 0.71,
  appliedMinConfidence: 0.6,
  cropSource: 'carried',
  detectorModelId: 'yolov9s-320-edgetpu',
  detectorDeviceKey: 'edgetpu:usb',
  detectorNodeId: 'agent-b',
  firstSeen: 1_699_999_999_000,
  motionOnsetAt: 1_699_999_996_000,
  birthLatencyMs: 3000,
  birthIndexInBurst: 0,
  ...over,
})

describe('BirthDecisionLedgerStore', () => {
  let world: FakeRecords
  let counted: InstrumentedRecords
  let recorder: ReturnType<typeof makeLogRecorder>
  let ledger: BirthDecisionLedgerStore
  const birthLedger = () => wireBirthDecisionLedger({ records: counted.records })
  const held = (): number => kindRows(world, 'birth-decision-ledger').length

  beforeEach(async () => {
    world = await makeAnalyticsRecords()
    counted = instrumentRecords(world.records)
    recorder = makeLogRecorder()
    ledger = new BirthDecisionLedgerStore({ birthLedger: birthLedger(), logger: recorder.logger })
  })

  it('keeps every column the decision was taken on', async () => {
    await ledger.append(draft())

    const rows = await ledger.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: 102,
      sourceTrackId: 'trk-1',
      className: 'person',
      verdict: 'confirmed',
      reason: 'confirmed',
      decidedOnCoastedFrame: false,
      birthEvidenceAvailable: true,
      decidedByBirthEvidence: true,
      birthLatencyMs: 3000,
      birthIndexInBurst: 0,
    })
  })

  it('stores a coasted, evidence-backed confirmation as two distinct facts', async () => {
    await ledger.append(
      draft({
        decidedOnCoastedFrame: true,
        birthEvidenceAvailable: true,
        decidedByBirthEvidence: false,
      }),
    )

    const rows = await ledger.list({})
    expect(rows[0]?.decidedOnCoastedFrame).toBe(true)
    expect(rows[0]?.decidedByBirthEvidence).toBe(false)
  })

  it('reports null — never a guessed number — for a decision with no measurement', async () => {
    await ledger.append(
      draft({
        verdict: 'exhausted-fallback',
        reason: 'no-crop',
        bestScore: null,
        appliedMinConfidence: null,
        motionOnsetAt: null,
        birthLatencyMs: null,
        birthIndexInBurst: null,
      }),
    )

    const rows = await ledger.list({})
    expect(rows[0]?.bestScore).toBeNull()
    expect(rows[0]?.birthLatencyMs).toBeNull()
  })

  it('NEVER throws — a failed measurement must not fail the birth it measures', async () => {
    // The real failure this models is `SQLITE_BUSY` during a checkpoint, which
    // D96 measured stalling hub-main for 25 s. A birth must survive it.
    world.failWrites(true)
    const broken = new BirthDecisionLedgerStore({
      birthLedger: birthLedger(),
      logger: recorder.logger,
    })

    await expect(broken.append(draft())).resolves.toBeUndefined()
    expect(recorder.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('answers newest-first', async () => {
    await ledger.append(draft({ at: 1000, sourceTrackId: 'old' }))
    await ledger.append(draft({ at: 3000, sourceTrackId: 'new' }))
    await ledger.append(draft({ at: 2000, sourceTrackId: 'mid' }))

    const rows = await ledger.list({})
    expect(rows.map((r) => r.sourceTrackId)).toEqual(['new', 'mid', 'old'])
  })

  it('filters per camera — the miss rate is always asked per camera', async () => {
    await ledger.append(draft({ deviceId: 102, sourceTrackId: 'a' }))
    await ledger.append(draft({ deviceId: 101, sourceTrackId: 'b' }))

    const rows = await ledger.list({ deviceId: 101 })
    expect(rows.map((r) => r.sourceTrackId)).toEqual(['b'])
  })

  it('filters per verdict — one population at a time', async () => {
    await ledger.append(draft({ sourceTrackId: 'a', verdict: 'confirmed' }))
    await ledger.append(draft({ sourceTrackId: 'b', verdict: 'suppressed', firstSeen: null }))

    const rows = await ledger.list({ verdict: 'suppressed' })
    expect(rows.map((r) => r.sourceTrackId)).toEqual(['b'])
  })

  it('filters by since', async () => {
    await ledger.append(draft({ at: 1000, sourceTrackId: 'old' }))
    await ledger.append(draft({ at: 5000, sourceTrackId: 'new' }))

    const rows = await ledger.list({ since: 2000 })
    expect(rows.map((r) => r.sourceTrackId)).toEqual(['new'])
  })

  it('holds the table at its ceiling, oldest first', async () => {
    const small = new BirthDecisionLedgerStore({
      birthLedger: birthLedger(),
      logger: recorder.logger,
      maxRows: 3,
      trimEvery: 1,
    })
    for (let i = 1; i <= 6; i += 1) {
      await small.append(draft({ at: i * 1000, sourceTrackId: `t${i}` }))
    }

    const rows = await small.list({})
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.sourceTrackId)).toEqual(['t6', 't5', 't4'])
  })

  it('AMORTISES the ceiling check — a birth does not pay for a count round trip', async () => {
    const amortised = new BirthDecisionLedgerStore({
      birthLedger: birthLedger(),
      logger: recorder.logger,
      maxRows: 2,
      trimEvery: 4,
    })
    for (let i = 1; i <= 3; i += 1) {
      await amortised.append(draft({ at: i * 1000, sourceTrackId: `t${i}` }))
    }
    // Three appends, cadence four: no `count` has been issued and the table is
    // deliberately over its ceiling. The overshoot is bounded by the cadence.
    expect(counted.calls('count')).toBe(0)
    expect(held()).toBe(3)

    await amortised.append(draft({ at: 4000, sourceTrackId: 't4' }))
    expect(counted.calls('count')).toBe(1)
    expect(held()).toBe(2)
  })

  it('defaults to the fleet-wide ceiling', () => {
    expect(BirthDecisionLedgerStore.defaultMaxRows()).toBe(MAX_BIRTH_DECISION_RECORDS)
  })
})
