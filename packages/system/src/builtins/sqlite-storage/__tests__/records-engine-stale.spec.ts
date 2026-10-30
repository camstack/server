/**
 * The engine side of the stale-data audit (D905): what an owner declared since
 * the engine started, the `orphaned` flag, the operator's drop, and the way a
 * declaration revives a flagged kind.
 */
import { UnknownRecordKindError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordsEngine } from '../records/records-engine.js'
import { declaration, type Harness, makeHarness, silentLogger } from './support/records-harness.js'

/** A second engine on the same file: a hub restart, the catalog loaded and nothing declared yet. */
function restartOf(h: Harness): RecordsEngine {
  return new RecordsEngine(h.db, {
    databaseId: 'settings',
    logger: silentLogger(),
    now: () => h.clock.now,
  })
}

const OWNER = 'gone-addon'

async function seeded() {
  const h = makeHarness()
  await h.engine.declareKinds({ owner: OWNER, kinds: { old: declaration(), live: declaration() } })
  await h.engine.putMany({
    owner: OWNER,
    kind: 'old',
    records: [
      { id: 'a', deviceId: 1, at: 1, data: {} },
      { id: 'b', deviceId: 1, at: 2, data: {} },
    ],
  })
  return h
}

describe('records engine: stale-data support', () => {
  it('reports a kind declared this boot, and one only the catalog remembers', async () => {
    const h = await seeded()
    // A second engine on the same file models a hub restart: the catalog loads,
    // nothing has declared yet.
    const restarted = restartOf(h)
    await restarted.declareKinds({ owner: OWNER, kinds: { live: declaration() } })
    const kinds = await restarted.listKinds({})
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.declaredThisBoot]))
    expect(byKind).toEqual({ old: false, live: true })
  })

  it('markKindsOrphaned flags only a declared kind nobody declared this boot', async () => {
    const h = await seeded()
    const restarted = restartOf(h)
    await restarted.declareKinds({ owner: OWNER, kinds: { live: declaration() } })
    const out = await restarted.markKindsOrphaned({
      kinds: [
        { owner: OWNER, kind: 'old' },
        { owner: OWNER, kind: 'live' },
      ],
    })
    expect(out.marked).toBe(1)
    const states = Object.fromEntries((await restarted.listKinds({})).map((k) => [k.kind, k.state]))
    expect(states).toEqual({ old: 'orphaned', live: 'declared' })
  })

  it('an orphaned kind still serves its owner, so a wrong flag breaks nothing', async () => {
    const h = await seeded()
    const restarted = restartOf(h)
    await restarted.markKindsOrphaned({ kinds: [{ owner: OWNER, kind: 'old' }] })
    const row = await restarted.get({ owner: OWNER, kind: 'old', id: 'a' })
    expect(row?.id).toBe('a')
  })

  it('a later declaration of an UNCHANGED kind revives it', async () => {
    const h = await seeded()
    const restarted = restartOf(h)
    await restarted.markKindsOrphaned({ kinds: [{ owner: OWNER, kind: 'old' }] })
    await restarted.declareKinds({ owner: OWNER, kinds: { old: declaration() } })
    // The CATALOG row, not the in-memory copy: the next boot reads the file.
    const stored = h.db
      .prepare<[], { state: string; orphaned_at: number | null }>(
        "SELECT state, orphaned_at FROM _record_kinds WHERE kind = 'old'",
      )
      .get()
    expect(stored).toEqual({ state: 'declared', orphaned_at: null })
  })

  it('dropKind deletes the rows, marks the kind dropped and refuses a second drop', async () => {
    const h = await seeded()
    const restarted = restartOf(h)
    await restarted.markKindsOrphaned({ kinds: [{ owner: OWNER, kind: 'old' }] })
    const out = await restarted.dropKind({ owner: OWNER, kind: 'old' })
    expect(out.deleted).toBe(2)
    expect((await restarted.listKinds({})).find((k) => k.kind === 'old')?.state).toBe('dropped')
    await expect(restarted.dropKind({ owner: OWNER, kind: 'old' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
  })

  it('dropKind refuses a kind that is not orphaned', async () => {
    const h = await seeded()
    await expect(h.engine.dropKind({ owner: OWNER, kind: 'live' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    expect((await h.engine.listKinds({})).find((k) => k.kind === 'live')?.state).toBe('declared')
  })

  it('markKindsOrphaned never flags a kind its owner declared this boot', async () => {
    const h = await seeded()
    await h.engine.markKindsOrphaned({ kinds: [{ owner: OWNER, kind: 'old' }] })
    expect((await h.engine.listKinds({})).find((k) => k.kind === 'old')?.state).toBe('declared')
  })
})
