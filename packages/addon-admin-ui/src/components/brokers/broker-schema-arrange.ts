/**
 * How a broker kind's settings form is laid out, decided from the schema
 * alone (no kind is named anywhere):
 *
 *   - fields the operator must supply come first;
 *   - a field that has a default (or a country default), or that an interactive
 *     sign-in fills (`filledBySignIn`, only when the kind offers one), moves
 *     into a collapsed "Advanced" section;
 *   - a field other fields' `showWhen` depends on stays where it is, as does a
 *     field with its own `showWhen` (visibility is evaluated per section, so
 *     splitting a condition from its discriminator would hide it for good).
 *
 * `countryDefaults` is the other half of "prefill what is derivable": a field's
 * `defaultByCountry[<operator country>]` becomes its initial value.
 */
import type {
  ConfigField,
  ConfigFieldBase,
  ConfigSection,
  ConfigUISchema,
} from '../../types/config-ui'

export const BROKER_ADVANCED_SECTION_ID = 'broker-advanced'

export interface ArrangeOptions {
  /** The kind offers an interactive sign-in. */
  readonly hasSignIn: boolean
  readonly advancedTitle: string
}

/** A field that carries the shared base props (structural fields such as separators do not). */
export function hasBase(field: ConfigField): field is ConfigField & ConfigFieldBase {
  return 'key' in field && typeof field.key === 'string' && 'label' in field
}

function referencedKeys(fields: readonly ConfigField[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const field of fields) {
    if (!hasBase(field)) continue
    const condition = field.showWhen
    if (condition === undefined) continue
    const conditions = Array.isArray(condition) ? condition : [condition]
    for (const c of conditions) {
      if (c !== null && typeof c === 'object' && 'field' in c && typeof c.field === 'string') {
        keys.add(c.field)
      }
    }
  }
  return keys
}

function isAdvanced(
  field: ConfigField,
  referenced: ReadonlySet<string>,
  hasSignIn: boolean,
): boolean {
  if (!hasBase(field) || field.showWhen !== undefined || referenced.has(field.key)) return false
  if (hasSignIn && field.filledBySignIn === true) return true
  return field.default !== undefined || field.defaultByCountry !== undefined
}

export function arrangeBrokerSchema(
  schema: ConfigUISchema,
  options: ArrangeOptions,
): ConfigUISchema {
  const advanced: ConfigField[] = []
  const sections: ConfigSection[] = []
  for (const section of schema.sections) {
    const referenced = referencedKeys(section.fields)
    const primary: ConfigField[] = []
    for (const field of section.fields) {
      if (isAdvanced(field, referenced, options.hasSignIn)) advanced.push(field)
      else primary.push(field)
    }
    if (primary.length > 0) {
      sections.push({ ...section, fields: primary })
    } else if (section.description !== undefined) {
      // A section that lost every field keeps its words (a caveat, a warning) as a note.
      const { description, ...rest } = section
      sections.push({
        ...rest,
        fields: [
          {
            type: 'info',
            key: `${section.id}-note`,
            label: '',
            content: description,
          },
        ],
      })
    }
  }
  if (advanced.length > 0) {
    sections.push({
      id: BROKER_ADVANCED_SECTION_ID,
      title: options.advancedTitle,
      style: 'accordion',
      defaultCollapsed: true,
      columns: 1,
      fields: advanced,
    })
  }
  return { ...schema, sections }
}

/** The operator's country (ISO alpha-2) from a BCP 47 tag such as `it-IT`, or null. */
export function countryOfLocale(locale: string | undefined): string | null {
  if (locale === undefined) return null
  const match = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(locale)
  return match?.[1] !== undefined ? match[1].toUpperCase() : null
}

/** Initial values a create form derives from the schema for `country`. Never overwrites `existing`. */
export function countryDefaults(
  schema: ConfigUISchema | undefined,
  country: string | null,
  existing: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (schema === undefined || country === null) return {}
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (!hasBase(field) || existing[field.key] !== undefined) continue
      const byCountry = field.defaultByCountry
      if (byCountry !== undefined && country in byCountry) out[field.key] = byCountry[country]
    }
  }
  return out
}
