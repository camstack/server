/**
 * The VeSync Country code is picked from a list, not typed. Every option the form offers must
 * parse with the same schema the record and the connection use, and "Not set" must keep the
 * blank = not set meaning.
 */
import type { ConfigField, ConfigSelectField } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildConnectionFormSchema, vesyncCountryCodeSchema } from '../config.js'

function isCountryCodeSelect(field: ConfigField): field is ConfigSelectField {
  return field.key === 'countryCode' && field.type === 'select'
}

function countryCodeField(): ConfigSelectField | undefined {
  return buildConnectionFormSchema()
    .sections.flatMap((section) => section.fields)
    .find(isCountryCodeSelect)
}

describe('the VeSync Country code field', () => {
  it('is a select whose every option parses with the country code schema', () => {
    const field = countryCodeField()
    expect(field).toBeDefined()
    const options = field?.options ?? []
    expect(options.length).toBeGreaterThan(20)
    for (const option of options) {
      expect(vesyncCountryCodeSchema.safeParse(option.value).success).toBe(true)
      expect(option.labelKey).toBe(
        `provider-vesync:connection.s_connection.countryCode.o_${option.value || 'none'}.label`,
      )
    }
  })

  it('offers "Not set" first, which parses to undefined, then countries sorted by name', () => {
    const options = countryCodeField()?.options ?? []
    expect(options[0]?.value).toBe('')
    expect(vesyncCountryCodeSchema.parse(options[0]?.value)).toBeUndefined()
    const labels = options.slice(1).map((o) => o.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
    expect(options.map((o) => o.value)).toContain('IT')
  })

  it('still accepts a stored two-letter code outside the list', () => {
    expect(vesyncCountryCodeSchema.parse('au')).toBe('AU')
  })
})
