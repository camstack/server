import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, OpsLogEntry } from '@camstack/types'
import {
  type RecordingOpsLogState,
  appendOpsLog,
  createRecordingOpsLogSink,
  listOpsLog,
  recordingOpsLogState,
} from '../ops-log-store.js'
import { makeRecorderRecords } from './fake-records.js'

/** A declared, empty `recorder`/`ops-log` handle on a fresh in-memory world. */
async function fakeState(): Promise<RecordingOpsLogState> {
  const world = await makeRecorderRecords()
  return recordingOpsLogState(world.records)
}

function makeRow(over: Partial<OpsLogEntry>): OpsLogEntry {
  return {
    id: 'op-1',
    at: 1_000,
    domain: 'recording',
    op: 'prune',
    reason: 'retention',
    deviceId: 101,
    nodeId: 'hub',
    itemsAffected: 3,
    bytesReclaimed: 100,
    detail: null,
    actor: 'operator',
    ...over,
  }
}

function fakeLogger(): IScopedLogger {
  const noop = () => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => fakeLogger(),
  } as unknown as IScopedLogger
}

describe('recorder ops-log store (RecordKindHandle)', () => {
  it('appends rows and lists them newest-first', async () => {
    const state = await fakeState()
    await appendOpsLog(state, makeRow({ id: 'a', at: 100 }))
    await appendOpsLog(state, makeRow({ id: 'b', at: 300 }))
    await appendOpsLog(state, makeRow({ id: 'c', at: 200 }))

    const rows = await listOpsLog(state, {})
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('filters by deviceId', async () => {
    const state = await fakeState()
    await appendOpsLog(state, makeRow({ id: 'a', deviceId: 101 }))
    await appendOpsLog(state, makeRow({ id: 'b', deviceId: 102 }))
    await appendOpsLog(state, makeRow({ id: 'c', deviceId: null }))

    const rows = await listOpsLog(state, { deviceId: 102 })
    expect(rows.map((r) => r.id)).toEqual(['b'])
  })

  it('caps the result at limit', async () => {
    const state = await fakeState()
    for (let i = 0; i < 10; i++) await appendOpsLog(state, makeRow({ id: `r${i}`, at: i }))
    const rows = await listOpsLog(state, { limit: 3 })
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.id)).toEqual(['r9', 'r8', 'r7'])
  })

  it('evicts the oldest rows past the ring cap', async () => {
    const state = await fakeState()
    for (let i = 0; i < 5; i++) await appendOpsLog(state, makeRow({ id: `r${i}`, at: i }), 3)
    // Only the newest 3 survive on disk.
    const rows = await listOpsLog(state, { limit: 100 })
    expect(rows.map((r) => r.id)).toEqual(['r4', 'r3', 'r2'])
  })

  it('validates rows on append (rejects a bad reason)', async () => {
    const state = await fakeState()
    await expect(
      appendOpsLog(state, makeRow({ reason: 'nope' as OpsLogEntry['reason'] })),
    ).rejects.toThrow()
  })

  it('the record `at` is set to OpsLogEntry.at so newest-first ordering works', async () => {
    const world = await makeRecorderRecords()
    const state = recordingOpsLogState(world.records)
    await appendOpsLog(state, makeRow({ id: 'early', at: 1_000 }))
    await appendOpsLog(state, makeRow({ id: 'late', at: 9_000 }))
    const rows = await listOpsLog(state, {})
    expect(rows[0]?.id).toBe('late')
    expect(rows[1]?.id).toBe('early')
  })

  describe('createRecordingOpsLogSink', () => {
    it('stamps domain/nodeId/id/at and persists', async () => {
      const state = await fakeState()
      const sink = createRecordingOpsLogSink({
        state,
        nodeId: 'agent-1',
        now: () => 12_345,
        newId: () => 'generated-id',
        logger: fakeLogger(),
      })
      await sink.append({
        op: 'manual-delete',
        reason: 'manual',
        deviceId: 101,
        itemsAffected: 2,
        bytesReclaimed: 999,
      })

      const rows = await sink.list({})
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: 'generated-id',
        at: 12_345,
        domain: 'recording',
        nodeId: 'agent-1',
        op: 'manual-delete',
        reason: 'manual',
        deviceId: 101,
        itemsAffected: 2,
        bytesReclaimed: 999,
        detail: null,
        actor: 'operator',
      })
    })

    it('append is best-effort — a write failure never throws', async () => {
      const world = await makeRecorderRecords()
      world.failWrites(true)
      const state = recordingOpsLogState(world.records)
      const warn = vi.fn()
      const logger = { ...fakeLogger(), warn } as unknown as IScopedLogger
      const sink = createRecordingOpsLogSink({
        state,
        nodeId: 'hub',
        now: () => 1,
        newId: () => 'x',
        logger,
      })
      await expect(
        sink.append({
          op: 'rescan',
          reason: 'operator',
          deviceId: null,
          itemsAffected: 0,
          bytesReclaimed: 0,
        }),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledOnce()
    })
  })
})
