import { describe, expect, it } from 'vitest'
import {
  type CapFacts,
  type ExportCoverageExpectations,
  type ExportCoverageInput,
  findExportCoverageViolations,
  parseExpectations,
  readCapNames,
} from '../check-export-coverage.js'

/**
 * The two failures this guard exists for, with their real numbers:
 *
 *  - **Coverage.** The previous HA exporter's default branch produced 177
 *    entities (of 293 devices) that never received a value. The new exporter
 *    replaced the default branch with two tables and a RUNTIME warning — which
 *    only fires on a hub that has the device bound, and only into a log nobody
 *    reads. 44 device-scoped caps are in neither table today.
 *  - **Field names.** `CAP_ENTITY_MAP` and `SENSOR_MAP` disagree on three
 *    sensor fields (`temperature`/`celsius`, `humidity`/`percent`,
 *    `illuminance`/`lux`), and eleven `CAP_ENTITY_MAP` entries name a field
 *    that does not exist in the cap's own status schema. Each of those is an
 *    entity that is published and can never carry a value.
 *
 * Every case below is written against the pure decision function, never
 * against the live tables — the live tables are being widened by other agents
 * while this runs, and a spec pinned to their contents would be a test of
 * today's snapshot rather than of the rule.
 */

const EMPTY_EXPECTATIONS: ExportCoverageExpectations = {
  unclassifiedCaps: [],
  mappedCapsWithoutDefinition: [],
  fieldsNotInStatusSchema: [],
  hapGenericTable: null,
}

const SWITCH_CAP: CapFacts = {
  name: 'switch',
  statusFields: ['on', 'lastChangedAt'],
}
const TEMP_CAP: CapFacts = {
  name: 'temperature-sensor',
  statusFields: ['celsius', 'unit'],
}
const BUTTON_CAP: CapFacts = { name: 'button', statusFields: null }

function input(patch: Partial<ExportCoverageInput> = {}): ExportCoverageInput {
  return {
    deviceCaps: [SWITCH_CAP],
    capEntityMap: { switch: { field: 'on' } },
    capsNotExported: [],
    itemEntityMap: {},
    sensorMap: {},
    hapGenericAccessoryExists: false,
    hapGenericTableRefExists: false,
    hapGenericTableCaps: null,
    expectations: EMPTY_EXPECTATIONS,
    ...patch,
  }
}

function kinds(violations: readonly { kind: string }[]): readonly string[] {
  return violations.map((v) => v.kind)
}

describe('coverage — every device cap is mapped, excluded, or expected', () => {
  it('passes when every device cap is in one of the two tables', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [SWITCH_CAP, TEMP_CAP],
          capEntityMap: { switch: { field: 'on' } },
          capsNotExported: ['temperature-sensor'],
        }),
      ),
    ).toEqual([])
  })

  it('FAILS on a cap in neither table and in no expectation', () => {
    const violations = findExportCoverageViolations(input({ deviceCaps: [SWITCH_CAP, TEMP_CAP] }))
    expect(kinds(violations)).toEqual(['unclassified-cap'])
    expect(violations[0]?.subject).toBe('temperature-sensor')
  })

  it('passes when the unclassified cap carries a written expectation', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [SWITCH_CAP, TEMP_CAP],
          expectations: {
            ...EMPTY_EXPECTATIONS,
            unclassifiedCaps: [
              {
                cap: 'temperature-sensor',
                reason: 'pending',
                resolvedBy: 'T3',
              },
            ],
          },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS on an expectation the tables have since answered — the ratchet only goes down', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [SWITCH_CAP],
        expectations: {
          ...EMPTY_EXPECTATIONS,
          unclassifiedCaps: [{ cap: 'switch', reason: 'pending', resolvedBy: 'T3' }],
        },
      }),
    )
    expect(kinds(violations)).toEqual(['stale-unclassified-expectation'])
  })

  it('FAILS on an expectation for a cap that no longer exists', () => {
    const violations = findExportCoverageViolations(
      input({
        expectations: {
          ...EMPTY_EXPECTATIONS,
          unclassifiedCaps: [{ cap: 'ghost-cap', reason: 'pending', resolvedBy: 'T3' }],
        },
      }),
    )
    expect(kinds(violations)).toEqual(['stale-unclassified-expectation'])
  })
})

describe('a mapping onto a capability that does not exist', () => {
  it('FAILS when the map names a cap with no definition', () => {
    const violations = findExportCoverageViolations(
      input({
        capEntityMap: { switch: { field: 'on' }, siren: { field: 'active' } },
      }),
    )
    expect(kinds(violations)).toEqual(['mapped-cap-without-definition'])
    expect(violations[0]?.subject).toBe('siren')
  })

  it('passes when the dangling mapping is written down', () => {
    expect(
      findExportCoverageViolations(
        input({
          capEntityMap: { switch: { field: 'on' }, siren: { field: 'active' } },
          expectations: {
            ...EMPTY_EXPECTATIONS,
            mappedCapsWithoutDefinition: [
              {
                cap: 'siren',
                reason: 'no siren.cap.ts exists',
                resolvedBy: 'T3',
              },
            ],
          },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS when the cap has since been defined', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [SWITCH_CAP, { name: 'siren', statusFields: ['active'] }],
        capEntityMap: { switch: { field: 'on' }, siren: { field: 'active' } },
        expectations: {
          ...EMPTY_EXPECTATIONS,
          mappedCapsWithoutDefinition: [
            {
              cap: 'siren',
              reason: 'no siren.cap.ts exists',
              resolvedBy: 'T3',
            },
          ],
        },
      }),
    )
    expect(kinds(violations)).toEqual(['stale-missing-definition-expectation'])
  })
})

describe('field authority — the cap status schema decides', () => {
  it('FAILS when the mapped field is absent from the cap status schema', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [TEMP_CAP],
        capEntityMap: { 'temperature-sensor': { field: 'temperature' } },
      }),
    )
    expect(kinds(violations)).toEqual(['field-not-in-status-schema'])
    expect(violations[0]?.message).toContain('celsius')
  })

  /**
   * The secondary entities. A widened capability is mostly extras — a
   * `climate-control` names one primary field and nine more underneath it —
   * and the 2026-08-14 write routes made six of them the field a native
   * Home Assistant control WRITES through. Only the primary was ever
   * asserted, so a typo one level down was an entity that read nothing and
   * a control that wrote into the void.
   */
  it('FAILS when a SECONDARY entity names a field the schema does not declare', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [TEMP_CAP],
        capEntityMap: {
          'temperature-sensor': {
            field: 'celsius',
            extras: { trend: 'fahrenheit' },
          },
        },
      }),
    )
    expect(kinds(violations)).toEqual(['extra-field-not-in-status-schema'])
    expect(violations[0]?.subject).toBe('temperature-sensor.trend')
  })

  it('passes when every secondary entity reads a field the schema declares', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [TEMP_CAP],
          capEntityMap: {
            'temperature-sensor': {
              field: 'celsius',
              extras: { same: 'celsius' },
            },
          },
        }),
      ),
    ).toEqual([])
  })

  it('passes when the violation is waived and the waiver names the authoritative field', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [TEMP_CAP],
          capEntityMap: { 'temperature-sensor': { field: 'temperature' } },
          expectations: {
            ...EMPTY_EXPECTATIONS,
            fieldsNotInStatusSchema: [
              {
                cap: 'temperature-sensor',
                mappedField: 'temperature',
                schemaField: 'celsius',
                reason: 'pending',
                resolvedBy: 'T3',
              },
            ],
          },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS when the waiver itself names a field the schema does not have', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [TEMP_CAP],
        capEntityMap: { 'temperature-sensor': { field: 'temperature' } },
        expectations: {
          ...EMPTY_EXPECTATIONS,
          fieldsNotInStatusSchema: [
            {
              cap: 'temperature-sensor',
              mappedField: 'temperature',
              schemaField: 'degrees',
              reason: 'pending',
              resolvedBy: 'T3',
            },
          ],
        },
      }),
    )
    expect(kinds(violations)).toEqual(['bad-field-expectation'])
  })

  it('FAILS on a waiver whose mapping has since been fixed', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [TEMP_CAP],
        capEntityMap: { 'temperature-sensor': { field: 'celsius' } },
        expectations: {
          ...EMPTY_EXPECTATIONS,
          fieldsNotInStatusSchema: [
            {
              cap: 'temperature-sensor',
              mappedField: 'temperature',
              schemaField: 'celsius',
              reason: 'pending',
              resolvedBy: 'T3',
            },
          ],
        },
      }),
    )
    expect(kinds(violations)).toEqual(['stale-field-expectation'])
  })

  it('asks nothing of a cap that declares no status schema', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [BUTTON_CAP],
          capEntityMap: { button: { field: 'pressed' } },
        }),
      ),
    ).toEqual([])
  })
})

describe('the two descriptor tables must agree', () => {
  it('passes when both tables name the same field', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [TEMP_CAP],
          capEntityMap: { 'temperature-sensor': { field: 'celsius' } },
          sensorMap: { 'temperature-sensor': { field: 'celsius' } },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS on an undeclared disagreement between CAP_ENTITY_MAP and SENSOR_MAP', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [
          {
            name: 'temperature-sensor',
            statusFields: ['celsius', 'temperature'],
          },
        ],
        capEntityMap: { 'temperature-sensor': { field: 'temperature' } },
        sensorMap: { 'temperature-sensor': { field: 'celsius' } },
      }),
    )
    expect(kinds(violations)).toEqual(['table-field-disagreement'])
  })

  it('accepts the disagreement only while the HA side is the waived, wrong one', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [TEMP_CAP],
          capEntityMap: { 'temperature-sensor': { field: 'temperature' } },
          sensorMap: { 'temperature-sensor': { field: 'celsius' } },
          expectations: {
            ...EMPTY_EXPECTATIONS,
            fieldsNotInStatusSchema: [
              {
                cap: 'temperature-sensor',
                mappedField: 'temperature',
                schemaField: 'celsius',
                reason: 'pending',
                resolvedBy: 'T3',
              },
            ],
          },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS when SENSOR_MAP itself names a field the schema does not have — it carries no waivers', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [TEMP_CAP],
        capEntityMap: { 'temperature-sensor': { field: 'celsius' } },
        sensorMap: { 'temperature-sensor': { field: 'degrees' } },
      }),
    )
    expect(kinds(violations)).toEqual(['sensor-map-field-not-in-status-schema'])
  })
})

describe('the HomeKit generic table, once it lands', () => {
  it('says nothing while the file does not exist', () => {
    expect(findExportCoverageViolations(input())).toEqual([])
  })

  it('FAILS the moment the file appears and nothing has wired it into this guard', () => {
    const violations = findExportCoverageViolations(input({ hapGenericAccessoryExists: true }))
    expect(kinds(violations)).toEqual(['hap-generic-table-unwired'])
  })

  it('passes once wired, and checks the table against the cap definitions', () => {
    expect(
      findExportCoverageViolations(
        input({
          hapGenericAccessoryExists: true,
          hapGenericTableRefExists: true,
          hapGenericTableCaps: ['switch'],
          expectations: {
            ...EMPTY_EXPECTATIONS,
            hapGenericTable: {
              file: 'packages/addon-export-hap/src/mappers/generic-accessory.ts',
              exportName: 'GENERIC_SERVICE_MAP',
            },
          },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS when the HAP table names a cap that does not exist', () => {
    const violations = findExportCoverageViolations(
      input({
        hapGenericAccessoryExists: true,
        hapGenericTableRefExists: true,
        hapGenericTableCaps: ['switch', 'ghost-cap'],
        expectations: {
          ...EMPTY_EXPECTATIONS,
          hapGenericTable: {
            file: 'packages/addon-export-hap/src/mappers/generic-accessory.ts',
            exportName: 'GENERIC_SERVICE_MAP',
          },
        },
      }),
    )
    expect(kinds(violations)).toEqual(['hap-cap-without-definition'])
  })

  it('FAILS when the wiring points at a file that is gone', () => {
    const violations = findExportCoverageViolations(
      input({
        hapGenericAccessoryExists: true,
        hapGenericTableRefExists: false,
        expectations: {
          ...EMPTY_EXPECTATIONS,
          hapGenericTable: {
            file: 'packages/addon-export-hap/src/mappers/generic-accessory.ts',
            exportName: 'GENERIC_SERVICE_MAP',
          },
        },
      }),
    )
    expect(kinds(violations)).toEqual(['stale-hap-generic-table'])
  })
})

describe('readCapNames — the two honest shapes a capability table takes', () => {
  it('reads a Record keyed by cap name (CAP_ENTITY_MAP)', () => {
    expect(readCapNames({ switch: { field: 'on' }, motion: { field: 'detected' } }, 'x')).toEqual([
      'switch',
      'motion',
    ])
  })

  it('reads an array of rows naming their caps (HAP_CAP_SERVICES), one row serving two caps', () => {
    expect(
      readCapNames([{ caps: ['switch', 'brightness'] }, { caps: ['lock-control'] }], 'x'),
    ).toEqual(['switch', 'brightness', 'lock-control'])
  })

  it('REFUSES a shape it cannot read, rather than reporting zero capabilities', () => {
    expect(() => readCapNames([{ services: ['switch'] }], 'x')).toThrow()
    expect(() => readCapNames('HAP_CAP_SERVICES', 'x')).toThrow()
  })

  it('REFUSES an empty table — a silent zero would pass the whole HomeKit half', () => {
    expect(() => readCapNames([], 'x')).toThrow()
    expect(() => readCapNames({}, 'x')).toThrow()
  })
})

describe('parseExpectations', () => {
  it('accepts the shape the guard writes', () => {
    const parsed = parseExpectations({
      unclassifiedCaps: [{ cap: 'cover', reason: 'T3 maps it', resolvedBy: 'T3' }],
      mappedCapsWithoutDefinition: [],
      fieldsNotInStatusSchema: [],
      hapGenericTable: null,
    })
    expect(parsed.unclassifiedCaps).toHaveLength(1)
  })

  it('refuses an entry with no written reason', () => {
    expect(() =>
      parseExpectations({
        unclassifiedCaps: [{ cap: 'cover', reason: '', resolvedBy: 'T3' }],
        mappedCapsWithoutDefinition: [],
        fieldsNotInStatusSchema: [],
        hapGenericTable: null,
      }),
    ).toThrow()
  })

  it('refuses a file that is not the expectations shape at all', () => {
    expect(() => parseExpectations({ caps: ['cover'] })).toThrow()
  })
})

describe('per-item capabilities (ITEM_ENTITY_MAP)', () => {
  const CONSUMABLES_CAP: CapFacts = {
    name: 'consumables',
    statusFields: ['items', 'lastChangedAt'],
  }

  it('counts a per-item capability as classified', () => {
    expect(
      findExportCoverageViolations(
        input({
          deviceCaps: [SWITCH_CAP, CONSUMABLES_CAP],
          itemEntityMap: { consumables: { itemsField: 'items' } },
        }),
      ),
    ).toEqual([])
  })

  it('FAILS on an items field the status schema does not carry', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [SWITCH_CAP, CONSUMABLES_CAP],
        itemEntityMap: { consumables: { itemsField: 'entries' } },
      }),
    )
    expect(kinds(violations)).toEqual(['item-field-not-in-status-schema'])
  })

  it('FAILS on a per-item capability that is not a device capability', () => {
    const violations = findExportCoverageViolations(
      input({ itemEntityMap: { ghosts: { itemsField: 'items' } } }),
    )
    expect(kinds(violations)).toEqual(['item-cap-without-definition'])
  })

  it('FAILS on a capability that is both minted per item and excluded', () => {
    const violations = findExportCoverageViolations(
      input({
        deviceCaps: [SWITCH_CAP, CONSUMABLES_CAP],
        itemEntityMap: { consumables: { itemsField: 'items' } },
        capsNotExported: ['consumables'],
      }),
    )
    expect(kinds(violations)).toEqual(['item-cap-also-excluded'])
  })
})
