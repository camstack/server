import { describe, expect, it } from 'vitest'
import { type DeviceAddonEntry, findViolations } from '../check-integration-instances-declared.js'

const GOOD_SOURCE = `
  const kind = defineEntryKind('accounts', { title: 'x', schema })
  description: { role: 'devices', instanceMode: 'multiple', kind: 'account', canTest: true }
`

function entry(id: string, capabilities: readonly string[]): DeviceAddonEntry {
  return { id, pkg: id, capabilities }
}

describe('check-integration-instances-declared', () => {
  it('passes a migrated addon with a record kind and a role, and a listed legacy one', () => {
    const found = findViolations(
      [
        entry('gizmo', ['device-provider', 'integration-instances']),
        entry('legacy', ['device-provider']),
      ],
      ['legacy'],
      () => GOOD_SOURCE,
    )
    expect(found).toEqual([])
  })

  it('refuses a migrated addon whose source has no record kind', () => {
    const found = findViolations(
      [entry('gizmo', ['device-adoption', 'integration-instances'])],
      [],
      () => "description: { role: 'devices' }",
    )
    expect(found.map((v) => v.message)).toEqual([expect.stringMatching(/no record kind/)])
  })

  it('refuses a migrated addon whose describe() answers no role', () => {
    const found = findViolations(
      [entry('gizmo', ['device-provider', 'integration-instances'])],
      [],
      () => "const kind = defineRecordKinds({ a: {} })\n description: { instanceMode: 'single' }",
    )
    expect(found.map((v) => v.message)).toEqual([
      expect.stringMatching(/no describe\(\) answers a role/),
    ])
  })

  it('refuses a NEW device addon that is on rows and not in the baseline', () => {
    const found = findViolations([entry('fresh', ['device-provider'])], [], () => '')
    expect(found).toEqual([
      { addon: 'fresh', message: expect.stringMatching(/does not declare integration-instances/) },
    ])
  })

  it('the baseline only shrinks: a migrated or vanished addon must leave it', () => {
    const found = findViolations(
      [entry('gizmo', ['device-provider', 'integration-instances'])],
      ['gizmo', 'ghost'],
      () => GOOD_SOURCE,
    )
    expect(found.map((v) => [v.addon, v.message])).toEqual([
      ['gizmo', expect.stringMatching(/still in the onRows baseline/)],
      ['ghost', expect.stringMatching(/remove the line/)],
    ])
  })

  it('ignores an entry that brings no devices', () => {
    expect(findViolations([entry('log', ['log-destination'])], [], () => '')).toEqual([])
  })
})
