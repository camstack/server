/**
 * The "Last run" cell's decision (D315): a rule is called absent ONLY by a
 * query that answered, and the window it names is the one the hub answered
 * with (`horizonMs`), never a constant.
 */
import type { NcRuleLastRuns } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  lastRunHorizonPhrase,
  type RuleLastRunsView,
  ruleLastRunCell,
} from '../notification-rule-last-run'

const DAY_MS = 24 * 3_600_000

function answered(data: NcRuleLastRuns): RuleLastRunsView {
  return { status: 'success', data, error: null }
}

describe('ruleLastRunCell', () => {
  it('pending: no claim at all', () => {
    expect(ruleLastRunCell({ status: 'pending', data: undefined, error: null }, 'r1')).toEqual({
      kind: 'pending',
    })
  })

  it('failed: says it could not look, with the reason', () => {
    const cell = ruleLastRunCell(
      { status: 'error', data: undefined, error: new Error('NOT_FOUND') },
      'r1',
    )
    expect(cell).toEqual({ kind: 'failed', reason: 'NOT_FOUND' })
  })

  it('answered and present: the run', () => {
    const cell = ruleLastRunCell(
      answered({
        runs: [{ ruleId: 'r1', lastAt: 5, status: 'dead', deviceId: 101 }],
        horizonMs: 7 * DAY_MS,
      }),
      'r1',
    )
    expect(cell).toEqual({ kind: 'ran', lastAt: 5, status: 'dead', deviceId: 101 })
  })

  it('answered and absent: absent, over the window the hub ANSWERED with', () => {
    const cell = ruleLastRunCell(answered({ runs: [], horizonMs: 3 * DAY_MS }), 'r1')
    expect(cell).toEqual({ kind: 'absent', phrase: 'Not in the last 3 days' })
  })
})

describe('lastRunHorizonPhrase', () => {
  it('derives the window from horizonMs', () => {
    expect(lastRunHorizonPhrase(7 * DAY_MS)).toBe('Not in the last 7 days')
    expect(lastRunHorizonPhrase(DAY_MS)).toBe('Not in the last day')
  })

  it('never rounds a narrowed window UP — 5.9 days is "5 days"', () => {
    expect(lastRunHorizonPhrase(5.9 * DAY_MS)).toBe('Not in the last 5 days')
  })

  it('under a day it speaks in hours, then minutes', () => {
    expect(lastRunHorizonPhrase(3.5 * 3_600_000)).toBe('Not in the last 3 hours')
    expect(lastRunHorizonPhrase(90_000)).toBe('Not in the last minute')
  })

  it('a null horizon (outbox kept forever) is "never on record"', () => {
    expect(lastRunHorizonPhrase(null)).toBe('No delivery on record')
  })
})
