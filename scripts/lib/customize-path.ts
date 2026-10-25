/**
 * Walk a dotted path through a Zod object, remembering nullability.
 * A history path helper unwraps before the caller can see `null`.
 */
import { z } from 'zod'

export type CustomizeLeafKind =
  | 'boolean'
  | 'number'
  | 'string'
  | 'enum'
  | 'array'
  | 'object'
  | 'other'

export type CustomizeValueLeafKind = 'boolean' | 'number' | 'string' | 'enum'

export interface CustomizePathHit {
  readonly kind: CustomizeLeafKind
  readonly nullable: boolean
  readonly enumValues: readonly string[]
  readonly schema: z.ZodType
}

export type CustomizePathResult =
  | { readonly ok: true; readonly hit: CustomizePathHit }
  | {
      readonly ok: false
      readonly rule: 'unknown-path' | 'path-into-collection'
      readonly message: string
    }

interface PeeledSchema {
  readonly nullable: boolean
  readonly schema: z.ZodType
}

export function isValueLeaf(kind: CustomizeLeafKind): kind is CustomizeValueLeafKind {
  return kind === 'boolean' || kind === 'number' || kind === 'string' || kind === 'enum'
}

export function resolveCustomizePath(root: z.ZodType, dotted: string): CustomizePathResult {
  const segments = dotted.split('.').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return { ok: false, rule: 'unknown-path', message: 'empty path' }
  }
  let current: z.ZodType = root
  for (const [index, segment] of segments.entries()) {
    const inner = peel(current).schema
    const parent = segments.slice(0, index).join('.') || 'runtimeState'
    if (!(inner instanceof z.ZodObject)) {
      return {
        ok: false,
        rule: 'path-into-collection',
        message: `\`${parent}\` is not a fixed object`,
      }
    }
    const next: unknown = inner.shape[segment]
    if (!(next instanceof z.ZodType)) {
      return {
        ok: false,
        rule: 'unknown-path',
        message: `\`${segment}\` is not a key of \`${parent}\``,
      }
    }
    current = next
  }
  return { ok: true, hit: describe(current) }
}

export function isOptionalSchema(schema: z.ZodType): boolean {
  let current = schema
  for (let guard = 0; guard < 16; guard += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) return true
    if (
      current instanceof z.ZodNullable ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap()
      continue
    }
    return false
  }
  return false
}

export function objectShape(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | undefined {
  const inner = peel(schema).schema
  if (!(inner instanceof z.ZodObject)) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(inner.shape)) {
    if (value instanceof z.ZodType) shape[key] = value
  }
  return shape
}

export function arrayElement(schema: z.ZodType): z.ZodType | undefined {
  if (!(schema instanceof z.ZodArray)) return undefined
  const element: unknown = schema.element
  return element instanceof z.ZodType ? element : undefined
}

function peel(schema: z.ZodType): PeeledSchema {
  let nullable = false
  let current = schema
  for (let guard = 0; guard < 16; guard += 1) {
    if (current instanceof z.ZodNullable) {
      nullable = true
      current = current.unwrap()
      continue
    }
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap()
      continue
    }
    return { nullable, schema: current }
  }
  return { nullable, schema: current }
}

function describe(schema: z.ZodType): CustomizePathHit {
  const peeled = peel(schema)
  const inner = peeled.schema
  if (inner instanceof z.ZodBoolean) return hit('boolean', peeled.nullable, [], inner)
  if (inner instanceof z.ZodNumber) return hit('number', peeled.nullable, [], inner)
  if (inner instanceof z.ZodString) return hit('string', peeled.nullable, [], inner)
  if (inner instanceof z.ZodEnum) {
    return hit(
      'enum',
      peeled.nullable,
      inner.options.map((option) => String(option)),
      inner,
    )
  }
  if (inner instanceof z.ZodArray) return hit('array', peeled.nullable, [], inner)
  if (inner instanceof z.ZodObject) return hit('object', peeled.nullable, [], inner)
  return hit('other', peeled.nullable, [], inner)
}

function hit(
  kind: CustomizeLeafKind,
  nullable: boolean,
  enumValues: readonly string[],
  schema: z.ZodType,
): CustomizePathHit {
  return { kind, nullable, enumValues, schema }
}
