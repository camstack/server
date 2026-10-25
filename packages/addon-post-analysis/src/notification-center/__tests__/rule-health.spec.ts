/**
 * D905 — a rule that cannot work is announced once per distinct reason, and
 * cleared once; a reading that did not answer raises and clears nothing.
 */
import { describe, expect, it } from 'vitest'
import type { NcPruneRecord } from '../device-prune-ledger.js'
import { NcRuleHealthMonitor } from '../rule-health.js'
import { rule } from './device-prune-fixtures.js'

function kept(
  ruleId: string,
  subjectKind: 'device' | 'target',
  subject: string,
  outcome: NcPruneRecord['outcome'] = 'kept-disabled',
): NcPruneRecord {
  return {
    kind: 'rule',
    ruleId,
    subjectKind,
    subject,
    field: subjectKind === 'device' ? 'conditions.devices' : 'targets',
    outcome,
    at: 1,
    source: 'reconcile',
  }
}

const robot = rule('r-robot', { name: 'Robot', enabled: false, conditions: { devices: [4483] } })

describe('NcRuleHealthMonitor', () => {
  it('a row the load skipped is broken ONCE, however many reloads see it', () => {
    const m = new NcRuleHealthMonitor()
    const skipped = [{ ruleId: 'r-x', name: 'Eventi', reason: 'groupingSec: Too small' }]
    const first = m.evaluate({ rules: [], skipped, prunes: [] })
    const second = m.evaluate({ rules: [], skipped, prunes: [] })

    expect(first).toEqual([
      {
        kind: 'broken',
        ruleId: 'r-x',
        ruleName: 'Eventi',
        reasons: [{ code: 'unparseable', ids: [], detail: 'groupingSec: Too small' }],
      },
    ])
    expect(second).toEqual([])
  })

  it('a rule still naming a device the prune confirmed deleted is broken once', () => {
    const m = new NcRuleHealthMonitor()
    const prunes = [kept('r-robot', 'device', '4483')]
    expect(m.evaluate({ rules: [robot], skipped: [], prunes })).toEqual([
      {
        kind: 'broken',
        ruleId: 'r-robot',
        ruleName: 'Robot',
        reasons: [{ code: 'device-deleted', ids: ['4483'] }],
      },
    ])
    expect(m.evaluate({ rules: [robot], skipped: [], prunes })).toEqual([])
  })

  it('a rule still naming a deleted delivery target is broken once', () => {
    const m = new NcRuleHealthMonitor()
    const r = rule('r-t', { targets: [{ targetId: 'gone' }] })
    const edges = m.evaluate({ rules: [r], skipped: [], prunes: [kept('r-t', 'target', 'gone')] })
    expect(edges).toMatchObject([
      { kind: 'broken', reasons: [{ code: 'target-deleted', ids: ['gone'] }] },
    ])
  })

  it('a device that is merely missing — no confirmed prune — breaks nothing', () => {
    const m = new NcRuleHealthMonitor()
    // A removed-from-a-list prune left the rule working; it is not broken either.
    const prunes = [kept('r-robot', 'device', '9999', 'removed')]
    expect(m.evaluate({ rules: [robot], skipped: [], prunes })).toEqual([])
  })

  it('an unanswered read raises nothing and clears nothing', () => {
    const m = new NcRuleHealthMonitor()
    expect(m.evaluate({ rules: null, skipped: null, prunes: null })).toEqual([])
    expect(m.evaluate({ rules: [robot], skipped: [], prunes: null })).toEqual([])

    m.evaluate({ rules: [robot], skipped: [], prunes: [kept('r-robot', 'device', '4483')] })
    // The prune record and the rule load both fail on the next tick: still broken, no edge.
    expect(m.evaluate({ rules: null, skipped: null, prunes: null })).toEqual([])
    expect(m.evaluate({ rules: [robot], skipped: [], prunes: null })).toEqual([])
  })

  it('repaired once when the rule no longer names the deleted device', () => {
    const m = new NcRuleHealthMonitor()
    const prunes = [kept('r-robot', 'device', '4483')]
    m.evaluate({ rules: [robot], skipped: [], prunes })
    const fixed = rule('r-robot', { name: 'Robot', conditions: { devices: [4700] } })

    expect(m.evaluate({ rules: [fixed], skipped: [], prunes })).toEqual([
      { kind: 'repaired', ruleId: 'r-robot', ruleName: 'Robot' },
    ])
    expect(m.evaluate({ rules: [fixed], skipped: [], prunes })).toEqual([])
  })

  it('repaired once when a skipped row loads again', () => {
    const m = new NcRuleHealthMonitor()
    m.evaluate({ rules: [], skipped: [{ ruleId: 'r-x', name: 'E', reason: 'bad' }], prunes: [] })
    const loaded = rule('r-x', { name: 'E' })
    expect(m.evaluate({ rules: [loaded], skipped: [], prunes: [] })).toEqual([
      { kind: 'repaired', ruleId: 'r-x', ruleName: 'E' },
    ])
  })

  it('a new reason on a broken rule is a new edge; a rule the operator deleted is forgotten silently', () => {
    const m = new NcRuleHealthMonitor()
    const two = rule('r-2', { conditions: { devices: [1] }, targets: [{ targetId: 'gone' }] })
    m.evaluate({ rules: [two], skipped: [], prunes: [kept('r-2', 'device', '1')] })
    const edges = m.evaluate({
      rules: [two],
      skipped: [],
      prunes: [kept('r-2', 'device', '1'), kept('r-2', 'target', 'gone')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      kind: 'broken',
      reasons: [{ code: 'device-deleted' }, { code: 'target-deleted' }],
    })

    expect(m.evaluate({ rules: [], skipped: [], prunes: [] })).toEqual([])
  })
})
