import { describe, expect, it } from 'vitest'
import { customizeApplyViolations } from '../lib/customize-apply.ts'

describe('customize apply is add (D944)', () => {
  it('rejects replace and add-or-replace and keeps add', () => {
    const found = customizeApplyViolations([
      {
        capName: 'battery',
        targets: [
          { id: 'percentage', apply: 'add' },
          { id: 'other', apply: 'replace' },
        ],
      },
      { capName: 'running-state', targets: [{ id: 'running', apply: 'add-or-replace' }] },
    ])
    expect(found).toEqual([
      "battery.other apply is 'replace' — D944 allows only 'add'",
      "running-state.running apply is 'add-or-replace' — D944 allows only 'add'",
    ])
  })
})
