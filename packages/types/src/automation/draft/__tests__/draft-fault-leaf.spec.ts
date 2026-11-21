/**
 * A fault row names a device that exists and serves the `error` cap; a draft
 * that names anything else is refused, readably, before it is saved.
 */
import { describe, expect, it } from 'vitest'
import { validateDraft } from '../validate-draft.js'
import { caseEntity, edited, SITE } from './draft-fixtures.js'

const WITH_ERROR = 9001
const WITHOUT_ERROR = 9002

const FAULT_SITE = {
  ...SITE,
  devices: [
    ...SITE.devices,
    {
      id: WITH_ERROR,
      name: 'Gateway',
      type: 'sensor',
      room: null,
      addonId: 'x',
      stableId: 'gw',
      caps: ['error'],
    },
    {
      id: WITHOUT_ERROR,
      name: 'Blind',
      type: 'sensor',
      room: null,
      addonId: 'x',
      stableId: 'blind',
      caps: ['switch'],
    },
  ],
}

const KINDS = ['device-fault-raised', 'device-fault-is'] as const

function issuesFor(kind: (typeof KINDS)[number], deviceId: number): readonly string[] {
  const entity = edited(caseEntity('automation', 'auto-02'), (r) => {
    r['when'] = { kind, deviceId, codes: [] }
  })
  const verdict = validateDraft('automation', entity, FAULT_SITE)
  return verdict.ok ? [] : verdict.issues
}

describe.each(KINDS)('validateDraft on %s', (kind) => {
  it('accepts a device that serves the error cap', () => {
    expect(issuesFor(kind, WITH_ERROR)).toEqual([])
  })

  it('refuses deviceId 0 and an unknown device', () => {
    expect(issuesFor(kind, 0)).toEqual(['when: no device has id 0'])
    expect(issuesFor(kind, 987654)).toEqual(['when: no device has id 987654'])
  })

  it('refuses a device that does not serve the error cap', () => {
    const issues = issuesFor(kind, WITHOUT_ERROR)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('does not serve cap "error"')
  })
})
