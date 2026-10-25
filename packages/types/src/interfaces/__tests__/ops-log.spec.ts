import { describe, it, expect } from 'vitest'
import {
  OpsLogEntrySchema,
  OpsLogQueryInputSchema,
  OpsLogDomainSchema,
  OpsLogOpSchema,
  OpsLogReasonSchema,
  OPS_LOG_DEFAULT_LIMIT,
  OPS_LOG_RING_DEFAULT_MAX,
} from '../ops-log.js'

describe('ops-log shared model', () => {
  const row = {
    id: 'op-1',
    at: 1_700_000_000_000,
    domain: 'recording' as const,
    op: 'prune' as const,
    reason: 'retention' as const,
    deviceId: 42,
    nodeId: 'hub',
    itemsAffected: 7,
    bytesReclaimed: 1234,
    detail: 'floor moved to X',
    actor: 'operator',
  }

  it('accepts a fully-populated recording row', () => {
    expect(OpsLogEntrySchema.parse(row)).toEqual(row)
  })

  it('accepts a cluster/global row with deviceId null and detail null', () => {
    const global = { ...row, domain: 'events' as const, deviceId: null, detail: null }
    expect(OpsLogEntrySchema.parse(global)).toEqual(global)
  })

  it('rejects an unknown domain / op / reason', () => {
    expect(OpsLogDomainSchema.safeParse('other').success).toBe(false)
    expect(OpsLogOpSchema.safeParse('vacuum').success).toBe(false)
    expect(OpsLogReasonSchema.safeParse('because').success).toBe(false)
  })

  it('rejects a row missing bytesReclaimed', () => {
    const { bytesReclaimed: _omit, ...missing } = row
    expect(OpsLogEntrySchema.safeParse(missing).success).toBe(false)
  })

  it('query input allows empty and bounds the limit', () => {
    expect(OpsLogQueryInputSchema.parse({})).toEqual({})
    expect(OpsLogQueryInputSchema.parse({ deviceId: 1, limit: 50 })).toEqual({
      deviceId: 1,
      limit: 50,
    })
    expect(OpsLogQueryInputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(OpsLogQueryInputSchema.safeParse({ limit: 5000 }).success).toBe(false)
  })

  it('exposes sensible defaults', () => {
    expect(OPS_LOG_DEFAULT_LIMIT).toBeGreaterThan(0)
    expect(OPS_LOG_RING_DEFAULT_MAX).toBeGreaterThanOrEqual(OPS_LOG_DEFAULT_LIMIT)
  })
})
