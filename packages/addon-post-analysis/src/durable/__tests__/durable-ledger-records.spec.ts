/**
 * A `DurableLedger` reads and writes through its `ctx.records` kind.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ncDurableRecordKinds } from '../../notification-center/nc-durable-record-kinds.js'
import { NC_LIVENESS_COLLECTION } from '../../notification-center/liveness-ledger.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { makeFakeRecords } from '../../pipeline-analytics/__tests__/fake-records.js'
import { pipelineAnalyticsRecordKinds } from '../../pipeline-analytics/record-kinds.js'
import { DurableLedger, type DurableLedgerSpec } from '../durable-ledger.js'

const COLLECTION = NC_LIVENESS_COLLECTION

interface Row {
  readonly subject: string
  readonly state: 'online' | 'offline'
  readonly kind: string
  readonly updatedAt: number
}

const spec: DurableLedgerSpec<Row> = {
  collection: COLLECTION,
  columns: [{ name: 'subject', type: 'TEXT', primaryKey: true, notNull: true }],
  writeMode: 'write-behind',
  keyOf: (row) => row.subject,
  toValue: (row) => ({ state: row.state, kind: row.kind, updatedAt: row.updatedAt }),
  fromRecord: (key, data) => ({
    subject: key,
    state: data['state'] === 'offline' ? 'offline' : 'online',
    kind: String(data['kind'] ?? ''),
    updatedAt: Number(data['updatedAt'] ?? 0),
  }),
  equalFact: (a, b) => a.state === b.state,
}

describe('DurableLedger records path', () => {
  let records: Awaited<ReturnType<typeof makeFakeRecords>>

  beforeEach(async () => {
    records = makeFakeRecords()
    await records.records.declare(ncDurableRecordKinds)
  })

  it('puts the record header deviceId when the kind requires device scope', async () => {
    await records.records.declare(pipelineAnalyticsRecordKinds)
    const ledger = new DurableLedger({
      spec: {
        collection: 'pipeline-analytics:stationary-evidence',
        columns: [{ name: 'key', type: 'TEXT', primaryKey: true, notNull: true }],
        writeMode: 'write-behind',
        keyOf: (row: { key: string; deviceId: number; n: number }) => row.key,
        toValue: (row) => ({ deviceId: row.deviceId, n: row.n }),
        fromRecord: (key, data) => {
          const deviceId = Number(data['deviceId'])
          const n = Number(data['n'])
          if (!Number.isFinite(deviceId) || !Number.isFinite(n)) return null
          return { key, deviceId, n }
        },
        deviceIdOf: (row) => row.deviceId,
      },
      kind: records.records.kind(pipelineAnalyticsRecordKinds['stationary-evidence']),
      logger: makeSilentLogger(),
    })
    await ledger.put({ key: '102:vehicle:abc', deviceId: 102, n: 1 })
    const stored = records.tables.get('stationary-evidence')?.get('102:vehicle:abc')
    expect(stored?.deviceId).toBe(102)
    expect(stored?.data['deviceId']).toBe(102)
  })

  it('write-behind put headers deviceId from deviceIdOf when the body omits it', async () => {
    await records.records.declare(pipelineAnalyticsRecordKinds)
    const ledger = new DurableLedger({
      spec: {
        collection: 'pipeline-analytics:stationary-evidence',
        columns: [{ name: 'key', type: 'TEXT', primaryKey: true, notNull: true }],
        writeMode: 'write-behind',
        keyOf: (row: { key: string; deviceId: number; n: number }) => row.key,
        // Body without deviceId — header must still come from deviceIdOf.
        toValue: (row) => ({ n: row.n }),
        fromRecord: (key, data) => {
          const n = Number(data['n'])
          if (!Number.isFinite(n)) return null
          return { key, deviceId: 0, n }
        },
        deviceIdOf: (row) => row.deviceId,
      },
      kind: records.records.kind(pipelineAnalyticsRecordKinds['stationary-evidence']),
      logger: makeSilentLogger(),
    })
    await ledger.put({ key: '104:person:a1', deviceId: 104, n: 2 })
    const stored = records.tables.get('stationary-evidence')?.get('104:person:a1')
    expect(stored?.deviceId).toBe(104)
  })

  it('persist writes the row to the kind', async () => {
    const ledger = new DurableLedger({
      spec,
      kind: records.records.kind(ncDurableRecordKinds.liveness),
      logger: makeSilentLogger(),
    })
    ledger.observe({
      subject: 'device:102',
      state: 'online',
      kind: 'device-online',
      updatedAt: 1,
    })
    await Promise.resolve()
    expect(records.tables.get('liveness')?.has('device:102')).toBe(true)
  })
})
