/**
 * Canonical expression text for one scalar transform. The decoder reads only
 * this spelling, so a stored row from the current builders still matches.
 */
import type { CompositionFieldSource } from '../composition.js'

const UNSIGNED = /^\d+(?:\.\d+)?$/
const SIGNED = /^-?\d+(?:\.\d+)?$/
const DWELL = /^dwell\(x (>=|<=) (\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\)$/
const LINEAR_CLAMP =
  /^clamp\((x|number\(x\)) \* (-?\d+(?:\.\d+)?) \+ (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)$/
const LINEAR_BARE = /^(x|number\(x\)) \* (-?\d+(?:\.\d+)?) \+ (-?\d+(?:\.\d+)?)$/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function unsignedToken(value: number): string | null {
  return token(value, UNSIGNED)
}

export function signedToken(value: number): string | null {
  return token(value, SIGNED)
}

export function constantExpr(value: string | number | boolean | null): string | null {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return signedToken(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return 'null'
}

export function isIdentifier(path: string): boolean {
  return IDENT.test(path)
}

export function dwellExpr(
  comparison: 'gte' | 'lte',
  threshold: string,
  start: string,
  stop: string,
): string {
  const op = comparison === 'gte' ? '>=' : '<='
  return `dwell(x ${op} ${threshold}, ${start}, ${stop})`
}

export function linearExpr(
  inner: 'x' | 'number(x)',
  scale: string,
  offset: string,
  clampMin: string | null,
  clampMax: string | null,
): string {
  const arithmetic = `${inner} * ${scale} + ${offset}`
  if (clampMin === null || clampMax === null) return arithmetic
  return `clamp(${arithmetic}, ${clampMin}, ${clampMax})`
}

export interface ParsedDwell {
  readonly comparison: 'gte' | 'lte'
  readonly threshold: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
}

export function parseDwell(expr: string): ParsedDwell | null {
  const match = DWELL.exec(expr)
  if (match === null) return null
  const threshold = Number(match[2])
  const startDwellMs = Number(match[3])
  const stopDwellMs = Number(match[4])
  if (
    !Number.isFinite(threshold) ||
    !Number.isFinite(startDwellMs) ||
    !Number.isFinite(stopDwellMs)
  ) {
    return null
  }
  const comparison = match[1] === '<=' ? 'lte' : 'gte'
  return { comparison, threshold, startDwellMs, stopDwellMs }
}

export interface ParsedLinear {
  readonly inner: 'x' | 'number(x)'
  readonly scale: number
  readonly offset: number
  readonly clampMin?: number
  readonly clampMax?: number
}

export function parseLinear(expr: string): ParsedLinear | null {
  const clamped = LINEAR_CLAMP.exec(expr)
  if (clamped !== null)
    return linearFrom(clamped[1], clamped[2], clamped[3], clamped[4], clamped[5])
  const bare = LINEAR_BARE.exec(expr)
  if (bare === null) return null
  return linearFrom(bare[1], bare[2], bare[3], undefined, undefined)
}

export interface BoundRead {
  readonly cap: string
  readonly fieldPath: string
  readonly addonId: string
  readonly stableId: string
}

export function singleFrom(source: CompositionFieldSource): BoundRead | null {
  if (source.kind === 'from') {
    return {
      cap: source.cap,
      fieldPath: source.fieldPath,
      addonId: source.source.addonId,
      stableId: source.source.stableId,
    }
  }
  if (source.kind !== 'expression' || Object.keys(source.bindings).length !== 1) return null
  const bound = source.bindings['x']
  if (bound === undefined || bound.kind !== 'from') return null
  return {
    cap: bound.cap,
    fieldPath: bound.fieldPath,
    addonId: bound.source.addonId,
    stableId: bound.source.stableId,
  }
}

function token(value: number, pattern: RegExp): string | null {
  if (!Number.isFinite(value)) return null
  const text = Object.is(value, -0) ? '0' : String(value)
  return pattern.test(text) ? text : null
}

function linearFrom(
  inner: string | undefined,
  scale: string | undefined,
  offset: string | undefined,
  clampMin: string | undefined,
  clampMax: string | undefined,
): ParsedLinear | null {
  if (inner !== 'x' && inner !== 'number(x)') return null
  if (scale === undefined || offset === undefined) return null
  const parsedScale = Number(scale)
  const parsedOffset = Number(offset)
  if (!Number.isFinite(parsedScale) || !Number.isFinite(parsedOffset)) return null
  if (clampMin === undefined || clampMax === undefined) {
    return { inner, scale: parsedScale, offset: parsedOffset }
  }
  const parsedMin = Number(clampMin)
  const parsedMax = Number(clampMax)
  if (!Number.isFinite(parsedMin) || !Number.isFinite(parsedMax)) return null
  return {
    inner,
    scale: parsedScale,
    offset: parsedOffset,
    clampMin: parsedMin,
    clampMax: parsedMax,
  }
}
