import type { ConfigSelectField } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { selectOffersPlaceholder } from '../config-form-field'

const options = [
  { value: 'adapter', label: 'Wired power' },
  { value: 'battery', label: 'Battery power' },
] as const

function selectField(extra: Partial<ConfigSelectField>): ConfigSelectField {
  return { type: 'select', key: 'k', label: 'K', options: [...options], ...extra }
}

describe('selectOffersPlaceholder', () => {
  it('offers none for a field that carries a default', () => {
    expect(selectOffersPlaceholder(selectField({ default: 'adapter' }))).toBe(false)
  })

  it('keeps it for an optional field without a default', () => {
    expect(selectOffersPlaceholder(selectField({}))).toBe(true)
  })

  it('offers none for a required field', () => {
    expect(selectOffersPlaceholder(selectField({ required: true }))).toBe(false)
  })

  it('offers none when the schema has its own empty option', () => {
    const own = [{ value: '', label: 'Auto' }, ...options]
    expect(selectOffersPlaceholder(selectField({ options: own }))).toBe(false)
  })
})
