/**
 * The broker form layout is decided from the schema alone: required, non-derivable
 * fields first; defaulted and sign-in-filled fields under a collapsed Advanced
 * section; a discriminator and the fields gated on it never separated.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../../../types/config-ui'
import {
  BROKER_ADVANCED_SECTION_ID,
  arrangeBrokerSchema,
  countryDefaults,
  countryOfLocale,
} from '../broker-schema-arrange'

const OPTIONS = { hasSignIn: false, advancedTitle: 'Advanced' } as const

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'conn',
      title: 'Connection',
      columns: 1,
      fields: [
        { type: 'text', key: 'host', label: 'Host', required: true },
        { type: 'number', key: 'port', label: 'Port', default: 1883 },
        {
          type: 'password',
          key: 'token',
          label: 'Token',
          filledBySignIn: true,
        },
        {
          type: 'select',
          key: 'region',
          label: 'Region',
          options: [{ value: 'a', label: 'a' }],
          default: 'a',
          defaultByCountry: { IT: 'b' },
        },
        {
          type: 'select',
          key: 'auth',
          label: 'Auth',
          options: [],
          default: 'token',
        },
        {
          type: 'text',
          key: 'secret',
          label: 'Secret',
          showWhen: { field: 'auth', equals: 'token' },
        },
      ],
    },
  ],
}

function keysOf(schema: ConfigUISchema, sectionId: string): string[] {
  const section = schema.sections.find((s) => s.id === sectionId)
  return (section?.fields ?? []).map((f) => ('key' in f ? f.key : ''))
}

describe('arrangeBrokerSchema', () => {
  it('moves defaulted fields under a collapsed accordion and keeps required ones first', () => {
    const arranged = arrangeBrokerSchema(SCHEMA, OPTIONS)
    expect(keysOf(arranged, 'conn')).toEqual(['host', 'token', 'auth', 'secret'])
    expect(keysOf(arranged, BROKER_ADVANCED_SECTION_ID)).toEqual(['port', 'region'])
    const advanced = arranged.sections.find((s) => s.id === BROKER_ADVANCED_SECTION_ID)
    expect(advanced).toMatchObject({
      style: 'accordion',
      defaultCollapsed: true,
      title: 'Advanced',
    })
  })

  it('keeps a discriminator and the field gated on it together, defaults notwithstanding', () => {
    const arranged = arrangeBrokerSchema(SCHEMA, OPTIONS)
    expect(keysOf(arranged, 'conn')).toEqual(expect.arrayContaining(['auth', 'secret']))
    expect(keysOf(arranged, BROKER_ADVANCED_SECTION_ID)).not.toContain('auth')
  })

  it('tucks the sign-in-filled fields away only when the kind offers a sign-in', () => {
    const withSignIn = arrangeBrokerSchema(SCHEMA, {
      ...OPTIONS,
      hasSignIn: true,
    })
    expect(keysOf(withSignIn, BROKER_ADVANCED_SECTION_ID)).toContain('token')
    expect(keysOf(withSignIn, 'conn')).not.toContain('token')
    expect(keysOf(arrangeBrokerSchema(SCHEMA, OPTIONS), 'conn')).toContain('token')
  })

  it('adds no Advanced section when nothing qualifies', () => {
    const plain: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [{ type: 'text', key: 'url', label: 'URL', required: true }],
        },
      ],
    }
    expect(arrangeBrokerSchema(plain, OPTIONS).sections.map((s) => s.id)).toEqual(['s'])
  })

  it('keeps the words of a section that lost every field, as a note', () => {
    const onlyDefaults: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          description: 'Sign in to link the account.',
          fields: [{ type: 'number', key: 'poll', label: 'Poll', default: 60 }],
        },
        {
          id: 't',
          title: 'T',
          fields: [{ type: 'number', key: 'x', label: 'X', default: 1 }],
        },
      ],
    }
    const arranged = arrangeBrokerSchema(onlyDefaults, OPTIONS)
    expect(arranged.sections.map((s) => s.id)).toEqual(['s', BROKER_ADVANCED_SECTION_ID])
    expect(arranged.sections[0]?.fields[0]).toMatchObject({
      type: 'info',
      content: 'Sign in to link the account.',
    })
  })
})

describe('country defaults', () => {
  it('reads the country of a BCP 47 tag', () => {
    expect(countryOfLocale('it-IT')).toBe('IT')
    expect(countryOfLocale('en_gb')).toBe('GB')
    expect(countryOfLocale('en')).toBeNull()
    expect(countryOfLocale(undefined)).toBeNull()
  })

  it('prefills a field from its country default and never overwrites a value', () => {
    expect(countryDefaults(SCHEMA, 'IT', {})).toEqual({ region: 'b' })
    expect(countryDefaults(SCHEMA, 'IT', { region: 'a' })).toEqual({})
    expect(countryDefaults(SCHEMA, 'DE', {})).toEqual({})
    expect(countryDefaults(SCHEMA, null, {})).toEqual({})
  })
})
