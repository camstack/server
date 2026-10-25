/**
 * Derive advanced Customize parameters from runtime Zod (D939).
 */
import { z } from 'zod'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { isZodSecret } from '../device/zod-secret.js'

export const ADVANCED_SHORT_STRING_MAX = 80

export type AdvancedParameterKind = 'boolean' | 'number' | 'string' | 'enum'

export interface DerivedAdvancedParameter {
  readonly path: string
  readonly kind: AdvancedParameterKind
  readonly label: string
  readonly unit?: string
  readonly enumValues?: readonly string[]
}

interface ZodMetaBag {
  readonly unit?: unknown
  readonly label?: unknown
  readonly config?: unknown
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

function runtimeTopLevelShape(
  runtimeSchema: z.ZodObject<z.core.$ZodLooseShape>,
): Readonly<Record<string, z.ZodType>> | undefined {
  let current: z.ZodType = runtimeSchema
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

function layersOf(schema: z.ZodType): readonly z.ZodType[] {
  const out: z.ZodType[] = []
  const queue: z.ZodType[] = [schema]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || out.includes(current)) continue
    out.push(current)
    const inner = nextLayer(current)
    if (inner !== null) queue.push(inner)
  }
  return out
}

function unitOnSchema(schema: z.ZodType): string | undefined {
  for (const layer of layersOf(schema)) {
    const unit = metaOf(layer)?.unit
    if (typeof unit === 'string' && unit.length > 0) return unit
  }
  return undefined
}

function hasConfigMeta(schema: z.ZodType): boolean {
  return layersOf(schema).some((layer) => metaOf(layer)?.config === true)
}

function labelFor(path: string, schema: z.ZodType): string {
  for (const layer of layersOf(schema)) {
    const label = metaOf(layer)?.label
    if (typeof label === 'string' && label.length > 0) return label
  }
  const description = schema.description
  if (typeof description === 'string' && description.length > 0) {
    const first = description.split('\n')[0]?.trim()
    if (first !== undefined && first.length > 0) return first
  }
  return path
}

function peelLeaf(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let guard = 0; guard < 16; guard += 1) {
    const inner = nextLayer(current)
    if (inner === null) return current
    current = inner
  }
  return current
}

function isShortStringSchema(schema: z.ZodType): boolean {
  const inner = peelLeaf(schema)
  if (!(inner instanceof z.ZodString)) return false
  const one = inner.safeParse('x')
  if (!one.success) return false
  const tooLong = inner.safeParse('x'.repeat(ADVANCED_SHORT_STRING_MAX + 1))
  return !tooLong.success
}

/** Provenance of a value (`native` / `assigned`, an origin, a kind) — not a parameter. */
const PROVENANCE_ENUM_PATHS: ReadonlySet<string> = new Set(['source', 'origin', 'kind'])

function isExcludedPath(
  path: string,
  ownedPaths: ReadonlySet<string>,
  eventTimestampPaths: ReadonlySet<string>,
): boolean {
  if (ownedPaths.has(path)) return true
  if (path === 'lastFetchedAt') return true
  if (path === 'id' || path.endsWith('Id')) return true
  if (path.endsWith('At') && !eventTimestampPaths.has(path)) return true
  return false
}

function isProvenanceEnum(path: string, schema: z.ZodType): boolean {
  if (!PROVENANCE_ENUM_PATHS.has(path)) return false
  return peelLeaf(schema) instanceof z.ZodEnum
}

function classifyLeaf(schema: z.ZodType): Omit<DerivedAdvancedParameter, 'path' | 'label'> | null {
  const inner = peelLeaf(schema)
  if (inner instanceof z.ZodBoolean) return { kind: 'boolean' }
  if (inner instanceof z.ZodEnum) {
    return {
      kind: 'enum',
      enumValues: inner.options.map((option) => String(option)),
    }
  }
  if (inner instanceof z.ZodNumber) {
    const unit = unitOnSchema(schema)
    if (unit === undefined) return null
    return { kind: 'number', unit }
  }
  if (inner instanceof z.ZodString && isShortStringSchema(schema)) {
    return { kind: 'string' }
  }
  return null
}

export function collectCustomizeOwnedPaths(spec: CapabilityCustomizeSpec): ReadonlySet<string> {
  const paths = new Set<string>()
  for (const target of spec.targets) {
    if (target.cardinality === 'scalar') {
      paths.add(target.path)
      continue
    }
    if (target.cardinality === 'keyedArray') {
      paths.add(target.path)
      paths.add(target.keyField)
      paths.add(target.labelField)
      for (const field of target.fields) paths.add(field.path)
      for (const trait of target.traits ?? []) paths.add(trait.path)
      continue
    }
    if (target.cardinality === 'event' && target.shape === 'pulse') {
      paths.add(target.timestampPath)
      paths.add(target.counterPath)
    }
  }
  return paths
}

export function collectEventTimestampPaths(spec: CapabilityCustomizeSpec): ReadonlySet<string> {
  const paths = new Set<string>()
  for (const target of spec.targets) {
    if (target.cardinality === 'event' && target.shape === 'pulse') {
      paths.add(target.timestampPath)
    }
  }
  return paths
}

export function deriveAdvancedParameters(
  runtimeSchema: z.ZodObject<z.core.$ZodLooseShape>,
  ownedPaths: ReadonlySet<string>,
  eventTimestampPaths: ReadonlySet<string>,
): readonly DerivedAdvancedParameter[] {
  const shape = runtimeTopLevelShape(runtimeSchema)
  if (shape === undefined) return []
  const rows: DerivedAdvancedParameter[] = []
  for (const [path, fieldSchema] of Object.entries(shape)) {
    if (isExcludedPath(path, ownedPaths, eventTimestampPaths)) continue
    if (isProvenanceEnum(path, fieldSchema)) continue
    if (isZodSecret(fieldSchema) || hasConfigMeta(fieldSchema)) continue
    const inner = peelLeaf(fieldSchema)
    if (inner instanceof z.ZodObject || inner instanceof z.ZodArray) continue
    const classified = classifyLeaf(fieldSchema)
    if (classified === null) continue
    rows.push({
      path,
      label: labelFor(path, fieldSchema),
      ...classified,
    })
  }
  return rows.toSorted((a, b) => a.path.localeCompare(b.path))
}
