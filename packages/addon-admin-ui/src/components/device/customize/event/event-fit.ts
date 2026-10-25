/**
 * A pulse source is a boolean that can rise: the cap's active field plus its
 * transition timestamp. A span source is that same active field; the
 * authority stores the device, not the path. Field fit reuses the scalar
 * declaration matcher (D936).
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  SOURCE_CAP_ACTIVE_FIELD,
  SOURCE_CAP_CHANGED_AT_FIELD,
} from '@camstack/types'
import type { WireableCatalog } from '../source-picker-model'
import { declarationSourceForField, scalarFieldOffers } from '../scalar/scalar-fit'

export type EventShape = 'pulse' | 'span'

export interface ActiveField {
  readonly cap: string
  readonly fieldPath: string
  readonly changedAtField: string | null
}

const DECLARATION_CAP: Readonly<Record<string, string>> = {
  binary: 'binary',
  switch: 'switch',
}

function isCatalogCap(cap: string): cap is keyof typeof CAP_CUSTOMIZE_CATALOG {
  return Object.hasOwn(CAP_CUSTOMIZE_CATALOG, cap)
}

function eventTarget(cap: string, targetId: string) {
  if (!isCatalogCap(cap)) return null
  const target = CAP_CUSTOMIZE_CATALOG[cap].targets.find((entry) => entry.id === targetId)
  if (target === undefined || target.cardinality !== 'event') return null
  return target
}

/** Cap names from the declaration's source kinds (for the cap index filter). */
export function eventDeclarationCaps(cap: string, targetId: string): readonly string[] {
  const target = eventTarget(cap, targetId)
  if (target === null) return []
  const out: string[] = []
  for (const source of target.sources) {
    const mapped = DECLARATION_CAP[source.kind]
    if (mapped !== undefined) out.push(mapped)
  }
  return out
}

export function eventDeviceCapEligible(
  deviceCaps: readonly string[],
  declarationCaps: readonly string[],
): boolean {
  return declarationCaps.some((name) => deviceCaps.includes(name))
}

function changedAtOnCap(catalog: WireableCatalog, cap: string): string | null {
  const changedAtField = SOURCE_CAP_CHANGED_AT_FIELD[cap] ?? null
  if (changedAtField === null) return null
  const entry = catalog.caps.find((row) => row.cap === cap)
  if (entry === undefined) return null
  return entry.fields.some((field) => field.path === changedAtField) ? changedAtField : null
}

/** The first wireable field this declaration accepts for the given shape. */
export function eventSourceFromWireable(
  catalog: WireableCatalog,
  cap: string,
  targetId: string,
  shape: EventShape,
): ActiveField | null {
  const target = eventTarget(cap, targetId)
  if (target === null) return null
  const offers = scalarFieldOffers(catalog, null).filter((row) => row.kind === 'boolean')
  for (const offer of offers) {
    if (declarationSourceForField(target.sources, offer) === null) continue
    const changedAtField = changedAtOnCap(catalog, offer.cap)
    if (shape === 'pulse' && changedAtField === null) continue
    return { cap: offer.cap, fieldPath: offer.path, changedAtField }
  }
  return null
}

export function activeFieldOf(catalog: WireableCatalog): ActiveField | null {
  for (const entry of catalog.caps) {
    const fieldPath = SOURCE_CAP_ACTIVE_FIELD[entry.cap]
    if (fieldPath === undefined) continue
    if (!entry.fields.some((field) => field.path === fieldPath)) continue
    const changedAtField = changedAtOnCap(catalog, entry.cap)
    return { cap: entry.cap, fieldPath, changedAtField }
  }
  return null
}

/** True only when the offered path is the active field and a transition time exists. */
export function pulseFieldFits(catalog: WireableCatalog, cap: string, fieldPath: string): boolean {
  const expected = SOURCE_CAP_ACTIVE_FIELD[cap]
  if (expected === undefined || expected !== fieldPath) return false
  const entry = catalog.caps.find((row) => row.cap === cap)
  if (entry === undefined || !entry.fields.some((field) => field.path === fieldPath)) {
    return false
  }
  return changedAtOnCap(catalog, cap) !== null
}
