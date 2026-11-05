import { describe, expect, it } from 'vitest'
import {
  type DeviceAddonEntry,
  findBrokerLinkViolations,
  findExporterViolations,
  findViolations,
} from '../check-integration-instances-declared.js'

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
      {
        addon: 'fresh',
        message: expect.stringMatching(/does not declare integration-instances/),
      },
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

describe('exporters are multi-instance (D1009)', () => {
  const MULTI = "description: { role: 'services', instanceMode: 'multiple' }"

  it('passes an exporter that provides integration-instances with instanceMode multiple', () => {
    expect(
      findExporterViolations(
        [entry('export-ok', ['device-export', 'integration-instances'])],
        () => MULTI,
      ),
    ).toEqual([])
  })

  it('refuses an exporter without integration-instances, naming the addon', () => {
    const found = findExporterViolations([entry('export-bare', ['device-export'])], () => MULTI)
    expect(found).toEqual([
      {
        addon: 'export-bare',
        message: expect.stringMatching(/does not declare integration-instances/),
      },
    ])
  })

  it("refuses an exporter declaring instanceMode 'single'", () => {
    const found = findExporterViolations(
      [entry('export-single', ['device-export', 'integration-instances'])],
      () => "description: { role: 'services', instanceMode: 'single' }",
    )
    expect(found.map((v) => v.addon)).toEqual(['export-single'])
  })

  it('refuses an exporter whose source declares no instanceMode at all', () => {
    const found = findExporterViolations(
      [entry('export-silent', ['device-export', 'integration-instances'])],
      () => '',
    )
    expect(found.map((v) => v.addon)).toEqual(['export-silent'])
  })
})

describe('broker-backed integrations go through the generic primitive (D1012)', () => {
  const backed = entry('acct', ['device-adoption', 'broker', 'integration-instances'])
  const GOOD = `
    export const kind = declareBrokerLinkKind({ title: 'x', writeTrigger: 'y', linkFields: { filter: z.string().optional() } })
  `

  it('passes an addon that declares its integration kind through declareBrokerLinkKind', () => {
    expect(findBrokerLinkViolations([backed], () => GOOD)).toEqual([])
  })

  it('ignores an addon that is not both a broker and an integration with devices', () => {
    expect(
      findBrokerLinkViolations(
        [
          entry('plain-broker', ['broker', 'integration-instances']),
          entry('devices-only', ['device-adoption', 'integration-instances']),
        ],
        () => '',
      ),
    ).toEqual([])
  })

  it('accepts the role a buildBrokerLinkInstances integration answers on its own', () => {
    expect(
      findViolations(
        [backed],
        [],
        () => 'declareBrokerLinkKind({}) buildBrokerLinkInstances(records, {}) defineEntryKind(',
      ),
    ).toEqual([])
  })

  it('refuses a broker-backed integration that does not use the primitive', () => {
    const found = findBrokerLinkViolations([backed], () => "defineEntryKind('brokers', {})")
    expect(found).toEqual([
      { addon: 'acct', message: expect.stringMatching(/declareBrokerLinkKind/) },
    ])
  })

  it('refuses a link field that is a password or any secret', () => {
    const secret = `declareBrokerLinkKind({ title: 'x', writeTrigger: 'y', linkFields: { password: z.string().meta({ secret: true }) } })`
    const found = findBrokerLinkViolations([backed], () => secret)
    expect(found.map((v) => v.message)).toEqual([expect.stringMatching(/password|secret/)])
  })
})
