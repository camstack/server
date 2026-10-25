import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeSilentLogger } from './test-helpers.js'
import { type FakeRecords, kindRows, makeAnalyticsRecords } from './fake-records.js'
import { wireOpsLogLedger } from '../store/event-ledger-wiring.js'
import { OpsLogStore } from '../store/ops-log-store.js'

describe('OpsLogStore (events domain)', () => {
  let world: FakeRecords
  let store: OpsLogStore
  let clock: number

  beforeEach(async () => {
    world = await makeAnalyticsRecords()
    clock = 0
    let seq = 0
    store = new OpsLogStore({
      opsLedger: wireOpsLogLedger({ records: world.records }),
      logger: makeSilentLogger(),
      nodeId: 'hub',
      now: () => clock,
      newId: () => `id-${seq++}`,
    })
  })

  it('writes into the ops-log records kind', async () => {
    clock = 7
    await store.append({
      op: 'prune',
      reason: 'retention',
      deviceId: null,
      itemsAffected: 0,
      bytesReclaimed: 0,
    })
    expect(kindRows(world, 'ops-log').map((r) => r.id)).toEqual(['id-0'])
  })

  it('appends rows stamped with domain/nodeId/id/at', async () => {
    clock = 111
    await store.append({
      op: 'prune',
      reason: 'retention',
      deviceId: 101,
      itemsAffected: 4,
      bytesReclaimed: 20,
    })
    const rows = await store.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'id-0',
      at: 111,
      domain: 'events',
      nodeId: 'hub',
      op: 'prune',
      reason: 'retention',
      deviceId: 101,
      itemsAffected: 4,
      bytesReclaimed: 20,
      detail: null,
      actor: 'operator',
    })
  })

  it('lists newest-first and honours limit', async () => {
    for (let i = 0; i < 5; i++) {
      clock = i * 10
      await store.append({
        op: 'prune',
        reason: 'retention',
        deviceId: 1,
        itemsAffected: i,
        bytesReclaimed: 0,
      })
    }
    const rows = await store.list({ limit: 2 })
    expect(rows.map((r) => r.at)).toEqual([40, 30])
  })

  it('filters by deviceId (global rows excluded when scoped)', async () => {
    await store.append({
      op: 'manual-delete',
      reason: 'manual',
      deviceId: 101,
      itemsAffected: 1,
      bytesReclaimed: 0,
    })
    await store.append({
      op: 'prune',
      reason: 'retention',
      deviceId: null,
      itemsAffected: 2,
      bytesReclaimed: 0,
    })
    await store.append({
      op: 'manual-delete',
      reason: 'manual',
      deviceId: 102,
      itemsAffected: 3,
      bytesReclaimed: 0,
    })

    const scoped = await store.list({ deviceId: 101 })
    expect(scoped.map((r) => r.deviceId)).toEqual([101])

    const all = await store.list({})
    expect(all).toHaveLength(3)
  })

  it('append is best-effort — an insert failure never throws', async () => {
    world.failWrites(true)
    const warn = vi.fn()
    const logger = { ...makeSilentLogger(), warn }
    const s = new OpsLogStore({
      opsLedger: wireOpsLogLedger({ records: world.records }),
      logger,
      nodeId: 'hub',
    })
    await expect(
      s.append({
        op: 'prune',
        reason: 'retention',
        deviceId: null,
        itemsAffected: 0,
        bytesReclaimed: 0,
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  describe('pruneBefore — the audit log needs retention of its own', () => {
    it('deletes only entries older than the cutoff and reports the count', async () => {
      for (const at of [100, 200, 300, 400]) {
        clock = at
        await store.append({
          op: 'prune',
          reason: 'retention',
          deviceId: 101,
          itemsAffected: 1,
          bytesReclaimed: 0,
        })
      }

      const deleted = await store.pruneBefore(300)

      expect(deleted).toBe(2)
      const left = await store.list({})
      expect(left.map((e) => e.at).sort((a, b) => a - b)).toEqual([300, 400])
    })

    it('is a no-op when nothing is old enough', async () => {
      clock = 500
      await store.append({
        op: 'prune',
        reason: 'retention',
        deviceId: null,
        itemsAffected: 0,
        bytesReclaimed: 0,
      })
      expect(await store.pruneBefore(100)).toBe(0)
      expect(await store.list({})).toHaveLength(1)
    })

    it('never throws — losing an audit trim must not fail the sweep that called it', async () => {
      world.failWrites(true)
      const warn = vi.fn()
      const s = new OpsLogStore({
        opsLedger: wireOpsLogLedger({ records: world.records }),
        logger: { ...makeSilentLogger(), warn },
        nodeId: 'hub',
      })
      await expect(s.pruneBefore(999)).resolves.toBe(0)
      expect(warn).toHaveBeenCalledOnce()
    })
  })
})
