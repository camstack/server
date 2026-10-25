/**
 * Derive the BINDABLE values of a capability from its own schema.
 *
 * The editor's source picker is built from this, so it cannot list a value
 * the resolver would fail to read, and a cap that ships a new state field
 * becomes bindable with no change here and none in the UI. The rejected
 * alternative — a hand-written table of "interesting" state paths — is the
 * thing that rots the day a cap adds a field.
 *
 * Pure Zod introspection through the public surface (`.shape`, `.unwrap()`,
 * `.options`). No `.def` reach-through, no casts.
 */

import type { CapabilityDefinition, OsdSourceValueType } from '@camstack/types'
import { z } from 'zod'

export interface StateLeaf {
  /** Dot path inside the cap's state slice. */
  readonly path: string
  readonly valueType: OsdSourceValueType
  readonly enumValues?: readonly string[]
}

/** Bookkeeping fields every slice carries — never worth putting on screen. */
const IGNORED_LEAF_PATHS: ReadonlySet<string> = new Set(['lastFetchedAt', 'lastChangedAt'])

/** Deepest a slice is walked. Beyond this a value is not a display value. */
const MAX_DEPTH = 2

/**
 * `.unwrap()` is typed against Zod's internal `$ZodType` base rather than
 * the public `ZodType`, so narrow it back with an `instanceof` guard
 * instead of a cast.
 */
function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType
}

/** One wrapper layer off, or `null` when `schema` is not a wrapper. */
function unwrapOnce(schema: z.ZodType): z.ZodType | null {
  const inner: unknown =
    schema instanceof z.ZodOptional
      ? schema.unwrap()
      : schema instanceof z.ZodNullable
        ? schema.unwrap()
        : schema instanceof z.ZodDefault
          ? schema.unwrap()
          : schema instanceof z.ZodReadonly
            ? schema.unwrap()
            : null
  return isZodType(inner) ? inner : null
}

/** Strip `optional` / `nullable` / `default` / `readonly` wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let i = 0; i < 8; i += 1) {
    const inner = unwrapOnce(current)
    if (inner === null) return current
    current = inner
  }
  return current
}

function leafType(schema: z.ZodType): StateLeaf['valueType'] | null {
  if (schema instanceof z.ZodNumber) return 'number'
  if (schema instanceof z.ZodBoolean) return 'boolean'
  if (schema instanceof z.ZodString) return 'string'
  if (schema instanceof z.ZodEnum) return 'enum'
  if (schema instanceof z.ZodLiteral) return 'string'
  return null
}

function enumValuesOf(schema: z.ZodType): readonly string[] | undefined {
  if (!(schema instanceof z.ZodEnum)) return undefined
  const options = schema.options
  const strings = options.filter((o): o is string => typeof o === 'string')
  return strings.length > 0 ? strings : undefined
}

function walk(schema: z.ZodType, prefix: string, depth: number, out: StateLeaf[]): void {
  const inner = unwrap(schema)

  if (inner instanceof z.ZodObject) {
    if (depth >= MAX_DEPTH) return
    for (const [key, child] of Object.entries(inner.shape)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (IGNORED_LEAF_PATHS.has(key)) continue
      if (child instanceof z.ZodType) walk(child, path, depth + 1, out)
    }
    return
  }

  // Arrays and records have no stable single value to burn into a slot.
  if (inner instanceof z.ZodArray || inner instanceof z.ZodRecord) return

  const valueType = leafType(inner)
  if (valueType === null || prefix === '') return
  out.push({ path: prefix, valueType, enumValues: enumValuesOf(inner) })
}

/**
 * Every bindable leaf of a cap's runtime state. Prefers `runtimeState`
 * (what the kernel actually mirrors under `device.state[capName]`) and
 * falls back to the `status` schema, which is what a `command-driven` cap
 * publishes into the same slice.
 */
export function stateLeavesOf(cap: CapabilityDefinition): readonly StateLeaf[] {
  const schema = cap.runtimeState ?? cap.status?.schema
  if (schema === undefined) return []
  const out: StateLeaf[] = []
  walk(schema, '', 0, out)
  return out
}

/** Read a dot path out of an untyped state slice. `undefined` when absent. */
export function readStatePath(slice: unknown, path: string): unknown {
  let current: unknown = slice
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    const next: Record<string, unknown> = { ...current }
    current = next[segment]
  }
  return current
}
