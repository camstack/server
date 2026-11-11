/**
 * `control.value` is a union (D1034): the pickers offer it as the kind the
 * picked device reads NOW — the Dreo angle control 3364 as a number, the 3D
 * preset select 3375 as a string — and not at all while that is unknown.
 */
import { describe, expect, it } from 'vitest'
import { liveWireableCatalog, type ReportedWireableCatalog } from '../source-picker-model'

const REPORTED: ReportedWireableCatalog = {
  caps: [
    {
      cap: 'control',
      fields: [
        { path: 'value', kind: 'union', unionMembers: ['number', 'string'] },
        { path: 'min', kind: 'number' },
      ],
    },
  ],
}

const valueKind = (snapshot: Parameters<typeof liveWireableCatalog>[1]) =>
  liveWireableCatalog(REPORTED, snapshot).caps[0]?.fields.find((f) => f.path === 'value')?.kind

describe('liveWireableCatalog', () => {
  it('offers a numeric control (3364) as a number', () => {
    expect(valueKind({ control: { value: 45, min: 0 } })).toBe('number')
  })

  it('offers the preset select (3375) as a string', () => {
    expect(valueKind({ control: { value: 'Preset 2' } })).toBe('string')
  })

  it('drops the union while the live value is unknown, and keeps plain fields', () => {
    expect(valueKind(null)).toBeUndefined()
    expect(liveWireableCatalog(REPORTED, null).caps[0]?.fields).toEqual([
      { path: 'min', kind: 'number' },
    ])
  })

  it('drops a live kind the union does not declare', () => {
    expect(valueKind({ control: { value: true } })).toBeUndefined()
  })
})
