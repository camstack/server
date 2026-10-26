import { z } from 'zod'
import { isReadingQuantity, type ReadingQuantity } from '../units/quantity.js'

export interface WireableField {
  readonly path: string
  readonly kind: 'string' | 'number' | 'boolean' | 'enum'
  readonly enumValues?: readonly string[]
  /** Quantity of a numeric reading, when the schema declares one. */
  readonly quantity?: ReadingQuantity
  /** True when `path` is relative to ONE item of an item-array cap (see
   *  `CapabilityStatusItemArray`) — a link targeting it must carry a
   *  `target.itemKey`. Absent/false for plain status fields. */
  readonly item?: boolean
}

/** Unwrap ZodNullable / ZodOptional / ZodDefault wrappers to reach the inner type.
 *  Zod v4 exposes `.unwrap()` on all three wrapper classes. */
export function unwrapSchema(schema: z.ZodType): z.ZodType {
  let s = schema
  while (s instanceof z.ZodNullable || s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    s = (
      s as z.ZodNullable<z.ZodType> | z.ZodOptional<z.ZodType> | z.ZodDefault<z.ZodType>
    ).unwrap()
  }
  return s
}

function isMetaBag(value: unknown): value is { readonly quantity?: unknown } {
  return typeof value === 'object' && value !== null
}

function metaQuantity(schema: z.ZodType): ReadingQuantity | undefined {
  const bag: unknown = z.globalRegistry.get(schema)
  if (isMetaBag(bag) && isReadingQuantity(bag.quantity)) return bag.quantity
  return undefined
}

/** Quantity declared with `readingMeta` on the field or on the unwrapped leaf. */
function quantityOfField(schema: z.ZodType): ReadingQuantity | undefined {
  return metaQuantity(schema) ?? metaQuantity(unwrapSchema(schema))
}

function leafKind(
  schema: z.ZodType,
): { kind: WireableField['kind']; enumValues?: readonly string[] } | null {
  const s = unwrapSchema(schema)
  if (s instanceof z.ZodEnum) return { kind: 'enum', enumValues: s.options as readonly string[] }
  if (s instanceof z.ZodNumber) return { kind: 'number' }
  if (s instanceof z.ZodString) return { kind: 'string' }
  if (s instanceof z.ZodBoolean) return { kind: 'boolean' }
  return null
}

/** Walk a cap status schema into flat wireable leaf fields (dotted paths).
 *  Recurses into nested ZodObject (unwrapping nullable/optional/default first),
 *  so fields with null live values are still offered. Arrays / unknown shapes
 *  are skipped — never throws. */
export function enumerateSchemaFields(schema: z.ZodType, prefix = ''): readonly WireableField[] {
  const root = unwrapSchema(schema)
  if (!(root instanceof z.ZodObject)) return []
  const out: WireableField[] = []
  const shape = root.shape as Record<string, z.ZodType>
  for (const [key, field] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key
    const inner = unwrapSchema(field)
    if (inner instanceof z.ZodObject) {
      out.push(...enumerateSchemaFields(inner, path))
      continue
    }
    const leaf = leafKind(field)
    if (leaf) {
      const quantity = quantityOfField(field)
      out.push({
        path,
        kind: leaf.kind,
        ...(leaf.enumValues ? { enumValues: leaf.enumValues } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      })
    }
  }
  return out
}

/** Enumerate the per-item wireable fields of an item-array cap (see
 *  `CapabilityStatusItemArray`): the item schema's leaf fields, minus the
 *  `keyField` (the key comes from the link's `itemKey`, never from a wired
 *  source), each tagged `item: true` so the authoring UI collects an
 *  `itemKey` alongside the field. Never throws. */
export function enumerateItemArrayFields(itemArray: {
  readonly keyField: string
  readonly itemSchema: z.ZodType
}): readonly WireableField[] {
  return enumerateSchemaFields(itemArray.itemSchema)
    .filter((f) => f.path !== itemArray.keyField)
    .map((f) => ({ ...f, item: true }))
}
