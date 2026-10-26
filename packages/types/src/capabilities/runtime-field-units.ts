/**
 * Unit meta on a runtime-state field (D941 convert-unit). Not an override list.
 * The lookup of the generated map lives in `runtime-field-unit.ts` so codegen
 * can import this walker without loading the file it is about to rewrite.
 */
import { z } from 'zod'
import { baseUnitOf, isReadingQuantity } from '../units/quantity.js'

interface ZodMetaBag {
  readonly unit?: unknown
  readonly quantity?: unknown
  readonly label?: unknown
}

function isMetaBag(value: unknown): value is ZodMetaBag {
  return typeof value === 'object' && value !== null
}

function metaOf(schema: z.ZodType): ZodMetaBag | undefined {
  const bag: unknown = z.globalRegistry.get(schema)
  return isMetaBag(bag) ? bag : undefined
}

function nextLayer(schema: z.ZodType): z.ZodType | null {
  if (
    !(schema instanceof z.ZodNullable) &&
    !(schema instanceof z.ZodOptional) &&
    !(schema instanceof z.ZodDefault) &&
    !(schema instanceof z.ZodReadonly) &&
    !(schema instanceof z.ZodCatch)
  ) {
    return null
  }
  const inner: unknown = schema.unwrap()
  return inner instanceof z.ZodType ? inner : null
}

function layersOf(schema: z.ZodType): readonly z.ZodType[] {
  const out: z.ZodType[] = []
  let current: z.ZodType | null = schema
  for (let guard = 0; guard < 16 && current !== null; guard += 1) {
    out.push(current)
    current = nextLayer(current)
  }
  return out
}

function unitOnSchema(schema: z.ZodType): string | undefined {
  for (const layer of layersOf(schema)) {
    const meta = metaOf(layer)
    const unit = meta?.unit
    if (typeof unit === 'string' && unit.length > 0) return unit
    // A labelled reading publishes its stored base. Unlabelled quantities stay
    // out — they are readings, not a convert-unit source (D944).
    if (isReadingQuantity(meta?.quantity) && typeof meta?.label === 'string') {
      const base = baseUnitOf(meta.quantity)
      if (base !== undefined) return base
    }
  }
  return undefined
}

function topLevelShape(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | undefined {
  let current = schema
  for (let guard = 0; guard < 16; guard += 1) {
    const inner = nextLayer(current)
    if (inner === null) break
    current = inner
  }
  if (!(current instanceof z.ZodObject)) return undefined
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(current.shape)) {
    if (value instanceof z.ZodType) shape[key] = value
  }
  return shape
}

/** Top-level runtime paths that declare a unit. */
export function runtimeFieldUnits(schema: z.ZodType): Readonly<Record<string, string>> {
  const shape = topLevelShape(schema)
  if (shape === undefined) return {}
  const units: Record<string, string> = {}
  for (const [path, field] of Object.entries(shape)) {
    const unit = unitOnSchema(field)
    if (unit !== undefined) units[path] = unit
  }
  return units
}
