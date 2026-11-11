/**
 * A create form whose discovered picker declares `pickManyOnCreate` (an Echo of an Amazon account):
 * the operator ticks several candidates and one record is created per ticked value, each named
 * after its candidate. Editing a stored record keeps the single picker.
 */
import type { ConfigField, ConfigSelectField, ConfigUISchema } from '@camstack/types'

/** The first top-level discovered select of the form that declares `pickManyOnCreate`, or null. */
export function pickManyField(schema: ConfigUISchema | null | undefined): ConfigSelectField | null {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields) {
      if (field.type === 'select' && field.discoverOptions?.pickManyOnCreate === true) return field
    }
  }
  return null
}

function asMultiple(field: ConfigField, key: string): ConfigField {
  if (field.type !== 'select' || field.key !== key || field.discoverOptions === undefined)
    return field
  return {
    ...field,
    discoverOptions: { ...field.discoverOptions, multiple: true },
  }
}

/** The form with the `key` picker holding several values. */
export function withMultiplePick(schema: ConfigUISchema, key: string): ConfigUISchema {
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => asMultiple(field, key)),
    })),
  }
}

/** One record to create: its name and the form values it is created with. */
export interface ManyCreateItem {
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * The records the ticked values make. One ticked value keeps the typed name; several are each
 * named after their candidate (the value itself when the list no longer offers it).
 */
export function manyCreateItems(input: {
  readonly key: string
  readonly picked: readonly string[]
  readonly labels: ReadonlyMap<string, string>
  readonly typedName: string
  readonly values: Readonly<Record<string, unknown>>
}): readonly ManyCreateItem[] {
  const { key, picked, labels, typedName, values } = input
  return picked.map((value) => ({
    name: picked.length === 1 && typedName.length > 0 ? typedName : (labels.get(value) ?? value),
    values: { ...values, [key]: value },
  }))
}

type ScalarValue = string | number | boolean

function isFilledScalar(value: unknown): value is ScalarValue {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'number' || typeof value === 'boolean'
}

/** The non-empty scalar form values: what the discovery is asked about (as the picker asks it). */
export function discoveryConfigOf(
  values: Readonly<Record<string, unknown>>,
): Record<string, ScalarValue> {
  const config: Record<string, ScalarValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isFilledScalar(value)) config[key] = value
  }
  return config
}

/** The candidate names by the value they give `key`: what each new record is named after. */
export function candidateLabels(
  candidates: readonly {
    readonly suggestedName: string
    readonly config: Readonly<Record<string, unknown>>
  }[],
  key: string,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const candidate of candidates) {
    const value = candidate.config[key]
    if (typeof value === 'string' && !labels.has(value)) labels.set(value, candidate.suggestedName)
  }
  return labels
}
