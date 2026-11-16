/**
 * The Kind column never holds a blank: a row whose provider declares no kind
 * (a fixed row such as Winston or Console) reads the table's default label.
 */
import { describe, expect, it } from 'vitest'
import { kindLabelOf } from '../InstancesTable'

const fixed = { kind: 'fixed' } as const

function record(kindLabel: string | undefined) {
  return kindLabel === undefined
    ? ({ kind: 'instance' } as const)
    : ({ kind: 'instance', kindLabel } as const)
}

describe('kindLabelOf', () => {
  it('a fixed row reads the default label', () => {
    expect(kindLabelOf(fixed, 'Log destination')).toBe('Log destination')
  })

  it("a record's own kind wins; a record without one reads the default", () => {
    expect(kindLabelOf(record('Webhook'), 'Log destination')).toBe('Webhook')
    expect(kindLabelOf(record(undefined), 'Log destination')).toBe('Log destination')
  })

  it('no default and no kind is blank, so the column stays hidden for tables that never asked', () => {
    expect(kindLabelOf(fixed, undefined)).toBe('')
  })
})
