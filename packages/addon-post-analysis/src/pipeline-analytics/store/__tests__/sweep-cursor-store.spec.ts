/**
 * The sweep cursor SURVIVES the process (D480).
 *
 * The orphan audit's resume offsets lived in a field on the addon instance,
 * behind a docblock arguing that persisting them "would be a durable record of
 * a purely advisory position". The addon respawns several times a day and the
 * sweep interval is six hours, so the cursor almost never survived to a second
 * pass: every pass re-walked offsets 0–20 000 of a 532 384-row collection and
 * stopped, for ten days, leaving 96 % of it — 23 594 orphaned rows, 9 714 MiB
 * — unexamined.
 *
 * The two directions that matter: a cursor written by one process is READ by
 * the next, and a store that cannot answer leaves the sweep starting from the
 * top (a re-walk) rather than somewhere invented.
 */
import { describe, expect, it } from 'vitest'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { decodeOrphanAuditCursors, SweepCursorStore } from '../sweep-cursor-store.js'

async function storeFor(): Promise<{
  readonly world: Awaited<ReturnType<typeof makeAnalyticsRecords>>
  readonly cursors: SweepCursorStore
  readonly logs: ReturnType<typeof makeLogRecorder>
}> {
  const world = await makeAnalyticsRecords()
  const logs = makeLogRecorder()
  return { world, cursors: SweepCursorStore.of(world.records, logs.logger), logs }
}

describe('SweepCursorStore', () => {
  it('round-trips the cursors a pass ended with — this IS the respawn', async () => {
    const { world, cursors } = await storeFor()
    await cursors.save({
      scopes: new Map([
        ['pipeline-analytics:media#track', 20_000],
        ['pipeline-analytics:media#motion', 0],
      ]),
      faceVectorCursor: 0,
      clipIndexCursors: new Map([['object-clip-siglip2-b16-224', 1_200]]),
      nowMs: 1_789_000_000_000,
    })

    const logs = makeLogRecorder()
    const reborn = SweepCursorStore.of(world.records, logs.logger)
    const loaded = await reborn.load()
    expect(loaded.scopes['pipeline-analytics:media#track']).toBe(20_000)
    expect(loaded.scopes['pipeline-analytics:media#motion']).toBe(0)
    expect(loaded.clipIndexCursors).toEqual({ 'object-clip-siglip2-b16-224': 1_200 })
    expect(loaded.updatedAtMs).toBe(1_789_000_000_000)
  })

  it('starts from the TOP when the row is missing — a re-walk, never an invented offset', async () => {
    const { cursors } = await storeFor()
    const loaded = await cursors.load()
    expect(loaded.scopes).toEqual({})
  })

  it('says so when the read fails, and still answers with the top', async () => {
    const { world, logs } = await storeFor()
    world.failReads(true)
    const cursors = SweepCursorStore.of(world.records, logs.logger)
    const loaded = await cursors.load()
    expect(loaded.scopes).toEqual({})
    expect(logs.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('ignores a value it cannot read rather than treating it as an offset', () => {
    expect(
      decodeOrphanAuditCursors({
        scopes: { good: 12, keyset: 'eyJpZCI6ImEifQ', empty: '', bad: null, negative: -5 },
        faceVectorCursor: -1,
        clipIndexCursors: { 'object-clip-siglip2-b16-224': 'nope', 'object-clip-x': 3 },
      }),
    ).toEqual({
      // A string is a records keyset cursor (opaque) — kept; an empty one is not.
      scopes: { good: 12, keyset: 'eyJpZCI6ImEifQ' },
      faceVectorCursor: 0,
      clipIndexCursors: { 'object-clip-x': 3 },
      updatedAtMs: 0,
    })
  })
})
