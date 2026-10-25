/**
 * The promoted-tape index read back through its records kind (follow-up 102,
 * item 1). The file name predates the kind: the round trip it pins is the
 * same one, now over the records world that keeps the engine's contract.
 *
 * `trackIds` is written as JSON text and must read back as the array, whether
 * the store sees the text it wrote or an already-decoded array. A parse that
 * ran `JSON.parse(String(array))` threw on a decoded array, set `trackIds` to
 * null, and skipped every promoted row as "malformed": `debug.tape.list`,
 * review and export never saw a single tape in production.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeRecords, makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { type LogRecorder, makeLogRecorder } from '../../__tests__/test-helpers.js'
import { TrackingTapeIndexStore, type TrackingTapeRow } from '../tracking-tape-index-store.js'

function tapeRow(id: string, trackIds: readonly string[]): TrackingTapeRow {
  return {
    id,
    deviceId: 102,
    scenario: 'parked-cars',
    note: null,
    lighting: 'day',
    fromMs: 1_000,
    toMs: 61_000,
    state: 'complete',
    frames: 420,
    skips: 0,
    gaps: 0,
    bytes: 123_456,
    reviewed: false,
    trackIds: [...trackIds],
    createdAt: 2_000,
    releasedAt: null,
    pinsSettled: false,
  }
}

describe('tracking-tape index over its records kind', () => {
  let world: FakeRecords
  let index: TrackingTapeIndexStore
  let log: LogRecorder

  beforeEach(async () => {
    const built = await makeAnalyticsWorld()
    world = built.world
    log = makeLogRecorder()
    index = new TrackingTapeIndexStore({
      tapeLedger: built.ledgers.trackingTapes,
      logger: log.logger,
    })
  })

  it('a promoted row reads back whole through list and get — its track ids included', async () => {
    await index.insert(tapeRow('p1', ['102-a', '102-b']))
    await index.insert({ ...tapeRow('p2', []), createdAt: 3_000 })

    // Newest first.
    const listed = await index.list(102)
    expect(listed.map((r) => [r.id, r.trackIds])).toEqual([
      ['p2', []],
      ['p1', ['102-a', '102-b']],
    ])
    expect((await index.get('p1'))?.trackIds).toEqual(['102-a', '102-b'])
    expect(log.entries.filter((e) => e.level === 'warn')).toEqual([])
  })

  it('reviewed / released / settled survive the round trip', async () => {
    await index.insert(tapeRow('p1', ['102-a']))
    await index.setReviewed('p1', true)
    await index.setReleased('p1', 9_000)
    const row = await index.get('p1')
    expect(row).toMatchObject({ reviewed: true, releasedAt: 9_000, pinsSettled: false })
    await index.setPinsSettled('p1', true)
    expect((await index.get('p1'))?.pinsSettled).toBe(true)
  })

  it('a row that is really malformed is still skipped, and said so with its camera', async () => {
    // A decoded array of NUMBERS: what a corrupt or hand-edited row holds.
    world.seed('tracking-tapes', {
      id: 'bad',
      deviceId: 102,
      at: 2_000,
      data: { ...rowData(tapeRow('bad', [])), trackIds: [1, 2] },
    })
    expect(await index.list(102)).toEqual([])
    expect(log.entries.map((e) => [e.level, e.message, e.extras?.tags])).toEqual([
      ['warn', 'tracking tape index: skipped a malformed row', { deviceId: 102 }],
    ])
    // It says WHY (fix round 1, review M3): the failing paths, and what the
    // column handed back — here an array of numbers.
    expect(log.entries[0]?.extras?.meta).toEqual({
      id: 'bad',
      issues: ['trackIds'],
      trackIdsType: 'object',
    })
  })

  it('free text that is whole JSON reads back as that text — the tape never vanishes (review M2)', async () => {
    // A backend may decode ANY text starting with `[` or `{`; the operator's
    // scenario and note are free text. Refused at promote (tape-actions), and
    // read back as text for a row written before that refusal.
    await index.insert({ ...tapeRow('p1', ['102-a']), scenario: '[]', note: '{"why":"parked"}' })
    const listed = await index.list(102)
    expect(listed.map((r) => [r.id, r.scenario, r.note, r.trackIds])).toEqual([
      ['p1', '[]', '{"why":"parked"}', ['102-a']],
    ])
    expect((await index.get('p1'))?.scenario).toBe('[]')
    expect(log.entries).toEqual([])
  })
})

function rowData(row: TrackingTapeRow): Record<string, unknown> {
  const { id: _id, ...rest } = row
  return rest
}
