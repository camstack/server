/**
 * The per-kind id counter must stay above every numeric id the kind holds.
 * Rows the records migration copied kept ids up to 3,276,634 while allocateId
 * started at 1; the upsert would have overwritten another device's row on the
 * first collision. A batch with caller-chosen numeric ids raises the counter of
 * ANY kind.
 */
import { RevConflictError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordsEngine } from '../records/records-engine.js'
import { declaration, makeHarness, silentLogger } from './support/records-harness.js'

const OWNER = 'spec-addon'

describe('records engine: id sequence', () => {
  it('a batch with {id:"500"} raises allocateId above it, on a kind that never allocated', async () => {
    const h = makeHarness()
    await h.engine.declareKinds({ owner: OWNER, kinds: { ev: declaration() } })
    await h.engine.putMany({
      owner: OWNER,
      kind: 'ev',
      records: [{ id: '500', deviceId: 1, at: 1, data: { legacy: true } }],
    })
    expect((await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id).toBeGreaterThanOrEqual(501)
  })

  it('a stale counter is corrected at boot', async () => {
    const h = makeHarness()
    await h.engine.declareKinds({ owner: OWNER, kinds: { ev: declaration() } })
    expect((await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id).toBe(1)
    await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: '2064513', deviceId: 1, at: 1, data: {} },
    })
    const reopened = new RecordsEngine(h.db, { databaseId: 'settings', logger: silentLogger() })
    expect((await reopened.allocateId({ owner: OWNER, kind: 'ev' })).id).toBeGreaterThan(2064513)
  })

  it('a write of an allocated id never overwrites another row', async () => {
    const h = makeHarness()
    await h.engine.declareKinds({ owner: OWNER, kinds: { ev: declaration() } })
    const id = (await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id
    await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: String(id), deviceId: 7, at: 1, data: { who: 'other camera' } },
    })
    // A stale counter hands out the same id again.
    h.db.prepare('UPDATE _record_sequences SET next = ?').run(id)
    const again = (await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id
    expect(again).toBe(id)
    await expect(
      h.engine.put({
        owner: OWNER,
        kind: 'ev',
        record: { id: String(again), deviceId: 8, at: 2, data: { who: 'new' } },
      }),
    ).rejects.toBeInstanceOf(RevConflictError)
    const kept = await h.engine.get({ owner: OWNER, kind: 'ev', id: String(id) })
    expect(kept?.deviceId).toBe(7)
    expect(h.logLines.some((l) => l.startsWith('warn: records: an allocated id collided'))).toBe(
      true,
    )
    // After its first write an id is an ordinary row again.
    const next = (await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id
    const rec = { id: String(next), deviceId: 1, at: 1, data: {} }
    await h.engine.put({ owner: OWNER, kind: 'ev', record: rec })
    await h.engine.put({ owner: OWNER, kind: 'ev', record: { ...rec, at: 2 } })
  })
})
