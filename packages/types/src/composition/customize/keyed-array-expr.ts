/**
 * Canonical expression text for one keyed-array transform. The decoder reads
 * only this spelling.
 */
import type { CustomizeTransformDraft } from './override-draft.js'

const STEP = /^x == ("(?:\\.|[^"\\])*") \? ("(?:\\.|[^"\\])*"|null) : ([\s\S]+)$/

export function enumMapExpr(mapping: Readonly<Record<string, string | null>>): string | null {
  const keys = Object.keys(mapping).toSorted()
  if (keys.length === 0) return null
  return keys.reduceRight<string | null>((rest, key) => {
    if (rest === null) return null
    const value = mapping[key]
    if (value === undefined) return null
    const rhs = value === null ? 'null' : JSON.stringify(value)
    return `x == ${JSON.stringify(key)} ? ${rhs} : ${rest}`
  }, 'null')
}

export function parseEnumMap(expr: string): Readonly<Record<string, string | null>> | null {
  const mapping: Record<string, string | null> = {}
  let rest = expr
  while (rest !== 'null') {
    const match = STEP.exec(rest)
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined
    ) {
      return null
    }
    const key = jsonString(match[1])
    const value = match[2] === 'null' ? null : jsonString(match[2])
    if (key === null || (match[2] !== 'null' && value === null)) return null
    if (Object.prototype.hasOwnProperty.call(mapping, key)) return null
    mapping[key] = value
    rest = match[3]
  }
  return Object.keys(mapping).length === 0 ? null : mapping
}

export function enumMapDraft(
  mapping: Readonly<Record<string, string | null>>,
): Extract<CustomizeTransformDraft, { kind: 'enum-map' }> {
  return { kind: 'enum-map', mapping: { ...mapping } }
}

function jsonString(token: string): string | null {
  try {
    const parsed: unknown = JSON.parse(token)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}
