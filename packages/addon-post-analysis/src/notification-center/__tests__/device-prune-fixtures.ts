/**
 * Builders shared by the deleted-device / deleted-target prune specs.
 *
 * Every object is PARSED through its real schema, so a fixture can never hold
 * a shape the store would refuse — a planner that passed against a hand-built
 * object the schema rejects would be the green-suite-is-not-proof failure.
 */
import { type NcRule, NcRuleSchema, type TimelapseRule, TimelapseRuleSchema } from '@camstack/types'
import { type NcSummaryRule, NcSummaryRuleSchema } from '../summary/summary-rule.js'
import type { NcPruneSnapshot } from '../device-prune.js'

export const SCHEDULE = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1320, endMinute: 360 }],
  timezone: 'UTC',
}

export function rule(id: string, overrides: Record<string, unknown> = {}): NcRule {
  return NcRuleSchema.parse({
    name: `rule ${id}`,
    delivery: 'immediate',
    targets: [{ targetId: 't-1' }],
    conditions: {},
    id,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

export function timelapse(id: string, overrides: Record<string, unknown> = {}): TimelapseRule {
  return TimelapseRuleSchema.parse({
    name: `timelapse ${id}`,
    deviceIds: [101],
    schedule: SCHEDULE,
    targets: [{ targetId: 't-1' }],
    id,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

export function summary(id: string, overrides: Record<string, unknown> = {}): NcSummaryRule {
  return NcSummaryRuleSchema.parse({
    name: `summary ${id}`,
    deviceIds: [101],
    window: { kind: 'motion', quietSeconds: 120, maxWindowSeconds: 3600 },
    targets: [{ targetId: 't-1' }],
    id,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

export function snapshot(overrides: Partial<NcPruneSnapshot> = {}): NcPruneSnapshot {
  return {
    rules: [],
    timelapse: [],
    summary: [],
    alarm: null,
    mutedDeviceIds: [],
    ...overrides,
  }
}

/** A guard that has recorded nothing — every last-id case is new. */
export const NOTHING_RECORDED = (): boolean => false
