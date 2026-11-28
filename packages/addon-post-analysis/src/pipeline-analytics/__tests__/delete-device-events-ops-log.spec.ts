/**
 * The device-removal reconcile replays every tombstone on every node at start
 * and every 6 h. A replay that removed nothing must not write an audit row —
 * it wrote ~16k empty `prune / orphaned-device` rows a day. A manual delete is
 * still audited even when empty, and a removal that removed something too.
 */
import type { IScopedLogger, OpsLogEntry } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import type { EventStore } from '../store/event-store.js'
import type { OpsLogStore } from '../store/ops-log-store.js'

type Appended = Omit<OpsLogEntry, 'id' | 'at' | 'domain' | 'nodeId' | 'actor'>

function facade(motion: number) {
  const appended: unknown[] = []
  const opsLog = {
    append: vi.fn(async (row: Appended) => {
      appended.push(row)
    }),
    list: vi.fn(async () => []),
  }
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  const f = new AnalyticsQueryFacade({
    trackStore: () => null,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double, only presence is read
    eventStore: () => ({}) as EventStore,
    mediaStore: () => null,
    sensorEventStore: () => null,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    opsLog: () => opsLog as unknown as OpsLogStore,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/x/event-media',
    logger: () => logger,
  })
  vi.spyOn(f, 'pruneEventsBefore').mockResolvedValue({ motion, object: 0, audio: 0 })
  return { f, appended }
}

describe('deleteDeviceEvents audit row', () => {
  it('a removal replay that removed nothing writes no row', async () => {
    const { f, appended } = facade(0)
    await f.deleteDeviceEvents({ deviceId: 5840, reason: 'orphaned-device' })
    expect(appended).toEqual([])
  })

  it('a removal that removed events is audited', async () => {
    const { f, appended } = facade(3)
    await f.deleteDeviceEvents({ deviceId: 5840, reason: 'orphaned-device' })
    expect(appended).toEqual([expect.objectContaining({ op: 'prune', itemsAffected: 3 })])
  })

  it('a manual delete is audited even when empty', async () => {
    const { f, appended } = facade(0)
    await f.deleteDeviceEvents({ deviceId: 5840 })
    expect(appended).toEqual([expect.objectContaining({ op: 'manual-delete', itemsAffected: 0 })])
  })
})
