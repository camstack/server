import { describe, expect, it } from 'vitest'
import { customizeApplyViolations } from '../lib/customize-apply.ts'

describe('customize apply is add, or a replace the cap declares (D944, D984)', () => {
  it('rejects an undeclared replace and add-or-replace and keeps add', () => {
    const found = customizeApplyViolations([
      {
        capName: 'battery',
        targets: [
          { id: 'percentage', apply: 'add' },
          { id: 'other', apply: 'replace', path: 'level' },
        ],
      },
      {
        capName: 'running-state',
        targets: [{ id: 'running', apply: 'add-or-replace' }],
      },
    ])
    expect(found).toEqual([
      "battery.other apply is 'replace' but the cap does not list it in overridable (D984)",
      "running-state.running apply is 'add-or-replace' — D944 allows only 'add' (and the 'replace' a cap declares overridable, D984)",
    ])
  })

  it('accepts a replace listed in the cap overridable for that target and path', () => {
    expect(
      customizeApplyViolations([
        {
          capName: 'lock-control',
          overridable: [{ path: 'state', by: 'door-contact' }],
          targets: [{ id: 'door-contact', apply: 'replace', path: 'state' }],
        },
      ]),
    ).toEqual([])
  })

  it('refuses a replace whose allow-list names another path or another target', () => {
    const wrongPath = customizeApplyViolations([
      {
        capName: 'lock-control',
        overridable: [{ path: 'state', by: 'door-contact' }],
        targets: [{ id: 'door-contact', apply: 'replace', path: 'lastChangedAt' }],
      },
    ])
    expect(wrongPath.length).toBe(2)
    const wrongTarget = customizeApplyViolations([
      {
        capName: 'lock-control',
        overridable: [{ path: 'state', by: 'other' }],
        targets: [{ id: 'door-contact', apply: 'replace', path: 'state' }],
      },
    ])
    expect(wrongTarget.length).toBe(2)
  })

  it('refuses an allow-list entry that names no replace target', () => {
    expect(
      customizeApplyViolations([
        {
          capName: 'battery',
          overridable: [{ path: 'level', by: 'percentage' }],
          targets: [{ id: 'percentage', apply: 'add', path: 'level' }],
        },
      ]),
    ).toEqual([
      'battery overridable level by percentage names no replace target on that path (D984)',
    ])
  })
})
