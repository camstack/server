import { z } from 'zod'
import { isReadingQuantity, type ReadingQuantity } from '../units/quantity.js'

/** A scalar member of a `union` field. */
export type WireableScalarKind = 'string' | 'number' | 'boolean'

export interface WireableField {
  readonly path: string
  /**
   * `union` (D1033): a field whose members are all scalars (`control.value` is
   * `number | string`). It is readable; which member a reading carries is the
   * SOURCE's live kind, judged where it is linked and again on every read.
   */
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'union'
  readonly enumValues?: readonly string[]
  /** Present only when `kind === 'union'`: the scalar kinds it may carry. */
  readonly unionMembers?: readonly WireableScalarKind[]
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

interface LeafKind {
  readonly kind: WireableField['kind']
  readonly enumValues?: readonly string[]
  readonly unionMembers?: readonly WireableScalarKind[]
}

function scalarKind(schema: z.ZodType): WireableScalarKind | null {
  const s = unwrapSchema(schema)
  if (s instanceof z.ZodNumber) return 'number'
  if (s instanceof z.ZodString) return 'string'
  if (s instanceof z.ZodBoolean) return 'boolean'
  return null
}

/** A union is a leaf only when EVERY member is a scalar; one object or array member keeps it out. */
function unionMembersOf(s: z.ZodUnion): readonly WireableScalarKind[] | null {
  const members: WireableScalarKind[] = []
  for (const option of s.options) {
    if (!(option instanceof z.ZodType)) return null
    const kind = scalarKind(option)
    if (kind === null) return null
    if (!members.includes(kind)) members.push(kind)
  }
  return members.length > 0 ? members : null
}

function leafKind(schema: z.ZodType): LeafKind | null {
  const s = unwrapSchema(schema)
  if (s instanceof z.ZodEnum) return { kind: 'enum', enumValues: s.options as readonly string[] }
  if (s instanceof z.ZodUnion) {
    const members = unionMembersOf(s)
    return members === null ? null : { kind: 'union', unionMembers: members }
  }
  const scalar = scalarKind(s)
  return scalar === null ? null : { kind: scalar }
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
        ...(leaf.unionMembers ? { unionMembers: leaf.unionMembers } : {}),
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
