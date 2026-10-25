import { describe, expect, it } from 'vitest'
import en from '../../../../i18n/en.json'
import it_ from '../../../../i18n/it.json'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function leaves(value: unknown, prefix = ''): readonly (readonly [string, string])[] {
  if (typeof value === 'string') return [[prefix, value]]
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix === '' ? k : `${prefix}.${k}`))
}

describe('the customize copy (spec U11, §10)', () => {
  const enLeaves = leaves(en.customize)
  const itLeaves = leaves(it_.customize)
  it('English and Italian carry the same keys', () => {
    expect(itLeaves.map(([k]) => k).toSorted()).toEqual(enLeaves.map(([k]) => k).toSorted())
  })
  it('no decision id reaches the operator', () => {
    const offenders = [...enLeaves, ...itLeaves].filter(([, v]) => /\bD\d{2,3}\b/.test(v))
    expect(offenders).toEqual([])
  })
})
