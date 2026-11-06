import { describe, expect, it } from 'vitest'
import type { FieldRow } from '../field-rows'
import { proposeFills } from '../fill-from-device'

const DEVICE = {
  id: 7,
  name: 'Pond sensor',
  addonId: 'ha',
  stableId: 'pond',
  location: null,
  type: 'sensor',
  parentDeviceId: null,
}

function toFill(cap: string, path: string): FieldRow {
  return { key: `${cap}.${path}`, cap, path, entry: null, advanced: false, item: null }
}

const CATALOG = {
  caps: [
    { cap: 'temperature-sensor', fields: [{ path: 'celsius', kind: 'number' as const }] },
    { cap: 'battery', fields: [{ path: 'level', kind: 'number' as const }] },
  ],
}

describe('proposeFills', () => {
  it('proposes the value that names the same field, and nothing for a field it cannot name', () => {
    const [temp, other] = proposeFills(
      [toFill('temperature-sensor', 'celsius'), toFill('temperature-sensor', 'humidityPct')],
      DEVICE,
      CATALOG,
      { 'temperature-sensor': { celsius: 21 }, battery: { level: 64 } },
    )
    expect(temp?.candidates.map((c) => `${c.cap}.${c.path}`)).toEqual([
      'temperature-sensor.celsius',
    ])
    expect(temp?.candidates[0]?.value).toBe(21)
    expect(other?.candidates).toEqual([])
  })

  it('ranks the same field of the same cap before the same name on another cap', () => {
    const [row] = proposeFills(
      [toFill('battery', 'level')],
      DEVICE,
      {
        caps: [
          { cap: 'tank', fields: [{ path: 'level', kind: 'number' as const }] },
          { cap: 'battery', fields: [{ path: 'level', kind: 'number' as const }] },
        ],
      },
      { tank: { level: 3 }, battery: { level: 64 } },
    )
    expect(row?.candidates.map((c) => c.cap)).toEqual(['battery', 'tank'])
  })

  it('leaves a field that already has a source alone', () => {
    const bound: FieldRow = {
      ...toFill('temperature-sensor', 'celsius'),
      entry: { kind: 'companion', companion: 'now' },
    }
    expect(proposeFills([bound], DEVICE, CATALOG, null)).toEqual([])
  })
})
