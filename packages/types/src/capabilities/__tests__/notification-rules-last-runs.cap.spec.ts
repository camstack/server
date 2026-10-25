/**
 * `notificationRules.getRuleLastRuns` — the contract a rules table reads its
 * "Last run" column from. Admin-only (it is a projection of the same outbox
 * `getHistory` reads, which is admin), a query, one call for every rule.
 */
import { describe, expect, it } from 'vitest'
import type { CapabilityDefinition } from '../capability-definition.js'
import { resolveMethodAuth } from '../cap-router-predicates.js'
import { NcRuleLastRunsSchema, notificationRulesCapability } from '../notification-rules.cap.js'

describe('notificationRules.getRuleLastRuns', () => {
  const def = notificationRulesCapability.methods.getRuleLastRuns
  /** Widened the way the router builder sees it: a cap that never set `internal`. */
  const cap: CapabilityDefinition = notificationRulesCapability

  it('is an admin query taking an empty object', () => {
    expect(def.kind).toBe('query')
    expect(resolveMethodAuth(cap, def)).toBe('admin')
    expect(def.input.safeParse({}).success).toBe(true)
  })

  it('answers the newest run per rule plus the horizon the answer covers', () => {
    const parsed = NcRuleLastRunsSchema.parse({
      runs: [{ ruleId: 'r1', lastAt: 1_700_000_000_000, status: 'sent', deviceId: 101 }],
      horizonMs: 7 * 24 * 3_600_000,
    })
    expect(parsed.runs[0]?.status).toBe('sent')
    expect(def.output.safeParse(parsed).success).toBe(true)
  })

  it('a horizon is REQUIRED — null (kept forever) is a value, absence is not', () => {
    expect(NcRuleLastRunsSchema.safeParse({ runs: [], horizonMs: null }).success).toBe(true)
    expect(NcRuleLastRunsSchema.safeParse({ runs: [] }).success).toBe(false)
  })

  it('refuses a status the outbox does not have', () => {
    expect(
      NcRuleLastRunsSchema.safeParse({
        runs: [{ ruleId: 'r1', lastAt: 1, status: 'throttled', deviceId: 1 }],
        horizonMs: 1,
      }).success,
    ).toBe(false)
  })
})
