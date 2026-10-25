import { describe, expect, it } from 'vitest'
import { reduceLastTriggers, type HistoryRow } from '../rule-triggers.js'

function row(partial: Partial<HistoryRow> & Pick<HistoryRow, 'ruleId' | 'createdAt'>): HistoryRow {
  return {
    ruleName: `rule ${partial.ruleId}`,
    deviceId: 101,
    status: 'sent',
    subject: { className: 'person' },
    ...partial,
  }
}

describe('reduceLastTriggers', () => {
  it('empty history: no overall, no rules', () => {
    const { overall, byRule } = reduceLastTriggers([])
    expect(overall).toBeNull()
    expect(byRule.size).toBe(0)
  })

  it('keeps the FIRST occurrence of each rule id — newest-first means most recent', () => {
    const rows: HistoryRow[] = [
      row({ ruleId: 'r1', createdAt: 300, ruleName: 'Driveway', status: 'sent' }),
      row({ ruleId: 'r2', createdAt: 200, ruleName: 'Garden' }),
      // An OLDER row for r1 — must be ignored, the first one already won.
      row({ ruleId: 'r1', createdAt: 100, ruleName: 'Driveway', status: 'dead' }),
    ]
    const { overall, byRule } = reduceLastTriggers(rows)
    expect(overall?.at).toBe(300)
    expect(overall?.ruleId).toBe('r1')
    expect(byRule.get('r1')?.at).toBe(300)
    expect(byRule.get('r1')?.status).toBe('sent')
    expect(byRule.get('r2')?.at).toBe(200)
    expect(byRule.size).toBe(2)
  })

  it('a rule absent from the page is absent from byRule — never invented', () => {
    const rows: HistoryRow[] = [row({ ruleId: 'r1', createdAt: 100 })]
    const { byRule } = reduceLastTriggers(rows)
    expect(byRule.has('r2')).toBe(false)
  })

  it('label falls back to className when the pipeline resolved none', () => {
    const rows: HistoryRow[] = [
      row({ ruleId: 'r1', createdAt: 100, subject: { className: 'dog' } }),
      row({ ruleId: 'r2', createdAt: 90, subject: { className: 'person', label: 'Alice' } }),
    ]
    const { byRule } = reduceLastTriggers(rows)
    expect(byRule.get('r1')?.label).toBe('dog')
    expect(byRule.get('r2')?.label).toBe('Alice')
  })

  it('artifactId is the first of artifactIds, or null when absent', () => {
    const rows: HistoryRow[] = [
      row({ ruleId: 'r1', createdAt: 100, artifactIds: ['art-1', 'art-2'] }),
      row({ ruleId: 'r2', createdAt: 90 }),
    ]
    const { byRule } = reduceLastTriggers(rows)
    expect(byRule.get('r1')?.artifactId).toBe('art-1')
    expect(byRule.get('r2')?.artifactId).toBeNull()
  })

  /**
   * The property the operator's task pins: the reduction's size tracks the
   * number of distinct RULE ids in the page, never the number of distinct
   * CAMERAS (`deviceId`) that fired them. A hundred cameras all triggering
   * the same two rules still produces two entries.
   */
  it('scales with distinct RULES, not with distinct CAMERAS', () => {
    const manyCamerasFewRules: HistoryRow[] = Array.from({ length: 100 }, (_, i) =>
      row({
        ruleId: i % 2 === 0 ? 'rule-person' : 'rule-vehicle',
        createdAt: 1000 - i,
        deviceId: 1000 + i,
      }),
    )
    const { byRule } = reduceLastTriggers(manyCamerasFewRules)
    expect(byRule.size).toBe(2)

    const fewCamerasManyRules: HistoryRow[] = Array.from({ length: 40 }, (_, i) =>
      row({ ruleId: `rule-${i}`, createdAt: 1000 - i, deviceId: (i % 3) + 1 }),
    )
    expect(reduceLastTriggers(fewCamerasManyRules).byRule.size).toBe(40)
  })
})
