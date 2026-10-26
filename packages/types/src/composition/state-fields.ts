/**
 * What a capability's state field IS: kind, nullability, whether required. The
 * validator needs nullability, which `enumerateSchemaFields` does not report,
 * and that decides a field's unavailable mode (D393).
 */
import { z } from 'zod'
import { enumerateSchemaFields, unwrapSchema, type WireableField } from '../device/schema-fields.js'

export interface StateFieldDescription {
  readonly path: string
  readonly kind: WireableField['kind']
  readonly nullable: boolean
  readonly required: boolean
  /** Present only when `kind === 'enum'` — the closed set of strings the field accepts. */
  readonly enumValues?: readonly string[]
}

function fieldAt(schema: z.ZodType, path: string): z.ZodType | null {
  let current: z.ZodType = schema
  for (const segment of path.split('.')) {
    const container = unwrapSchema(current)
    if (!(container instanceof z.ZodObject)) return null
    const next: unknown = container.shape[segment]
    if (!(next instanceof z.ZodType)) return null
    current = next
  }
  return current
}

export function describeStateField(schema: z.ZodType, path: string): StateFieldDescription | null {
  const leaf = enumerateSchemaFields(schema).find((f) => f.path === path)
  if (leaf === undefined) return null
  const field = fieldAt(schema, path)
  if (field === null) return null
  return {
    path,
    kind: leaf.kind,
    nullable: field.safeParse(null).success,
    required: !field.safeParse(undefined).success,
    ...(leaf.enumValues === undefined ? {} : { enumValues: leaf.enumValues }),
  }
}

export function describeTopLevelStateFields(
  schema: z.ZodType,
): ReadonlyMap<string, StateFieldDescription> {
  return new Map(
    enumerateSchemaFields(schema)
      .filter((f) => !f.path.includes('.'))
      .flatMap((f) => {
        const described = describeStateField(schema, f.path)
        return described === null ? [] : [[f.path, described] as const]
      }),
  )
}

/** Top-level keys a value MUST carry: those whose schema refuses `undefined`. */
export function requiredTopLevelKeys(schema: z.ZodType): readonly string[] {
  const root = unwrapSchema(schema)
  if (!(root instanceof z.ZodObject)) return []
  return Object.entries(root.shape).flatMap(([key, field]) =>
    field instanceof z.ZodType && !field.safeParse(undefined).success ? [key] : [],
  )
}

/**
 * The proper prefixes of `path` whose schema accepts `undefined`: a required
 * leaf under one of them is required only once something writes that parent
 * (`remaining.kind` is required only when `remaining` is present).
 */
export function optionalAncestors(schema: z.ZodType, path: string): readonly string[] {
  const segments = path.split('.')
  return segments.slice(0, -1).flatMap((_, i) => {
    const prefix = segments.slice(0, i + 1).join('.')
    const field = fieldAt(schema, prefix)
    return field !== null && field.safeParse(undefined).success ? [prefix] : []
  })
}
