/**
 * Several scalar targets of ONE capability share one stored `fields` feature
 * (D951): "Power and energy" assigns power, energy, voltage and current, each
 * from its own device. A target owns its value path and the companion paths it
 * writes. Merging replaces only what the target owns; removing takes only what
 * no other target of the cap still needs (a companion such as the clock is
 * shared and goes last).
 */
import type {
  CustomizeCatalog,
  CustomizeCatalogTarget,
} from '../../capabilities/customize-catalog.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CompositionFieldSource, CompositionFieldsFeature } from '../composition.js'

type FieldMap = Readonly<Record<string, CompositionFieldSource>>

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

function scalarTargets(cap: string): readonly CustomizeCatalogTarget[] {
  return (catalog[cap]?.targets ?? []).filter(
    (target) => target.cardinality === 'scalar' && target.path !== undefined,
  )
}

/** How many scalar targets the cap declares: above one, the cap's feature is shared. */
export function scalarTargetCount(cap: string): number {
  return scalarTargets(cap).length
}

function valuePath(target: CustomizeCatalogTarget): string {
  return target.path ?? target.id
}

function ownedPaths(target: CustomizeCatalogTarget): readonly string[] {
  return [valuePath(target), ...(target.companions ?? []).map((companion) => companion.path)]
}

function find(cap: string, targetId: string): CustomizeCatalogTarget | null {
  return scalarTargets(cap).find((target) => target.id === targetId) ?? null
}

function without(fields: FieldMap, paths: ReadonlySet<string>): FieldMap {
  return Object.fromEntries(Object.entries(fields).filter(([path]) => !paths.has(path)))
}

/**
 * The cap's feature with `compiled` (one target's own feature) merged in. A cap
 * with one scalar target is replaced whole, as before.
 */
export function mergeScalarTarget(
  current: CompositionFieldsFeature | null,
  compiled: CompositionFieldsFeature,
  cap: string,
  targetId: string,
): CompositionFieldsFeature {
  const target = find(cap, targetId)
  if (current === null || target === null || scalarTargetCount(cap) < 2) return compiled
  const kept = without(current.fields, new Set(ownedPaths(target)))
  return { ...current, ...compiled, fields: { ...kept, ...compiled.fields } }
}

/** The cap's feature without `targetId`'s paths; null when no target value is left. */
export function removeScalarTarget(
  current: CompositionFieldsFeature | null,
  cap: string,
  targetId: string,
): CompositionFieldsFeature | null {
  if (current === null) return null
  const target = find(cap, targetId)
  if (target === null || scalarTargetCount(cap) < 2) return null
  const others = scalarTargets(cap).filter((row) => row.id !== targetId)
  const stillAssigned = others.filter((row) => current.fields[valuePath(row)] !== undefined)
  if (stillAssigned.length === 0) return null
  const needed = new Set(stillAssigned.flatMap((row) => ownedPaths(row)))
  const drop = new Set(ownedPaths(target).filter((path) => !needed.has(path)))
  return { ...current, fields: without(current.fields, drop) }
}

/**
 * The part of a stored feature one target owns — what a decode compares with
 * its recompiled feature. A cap with one target compares the whole feature.
 */
export function ownedSlice(
  stored: CompositionFieldsFeature,
  cap: string,
  targetId: string,
): CompositionFieldsFeature {
  const target = find(cap, targetId)
  if (target === null || scalarTargetCount(cap) < 2) return stored
  const owned = new Set(ownedPaths(target))
  return {
    ...stored,
    fields: Object.fromEntries(Object.entries(stored.fields).filter(([path]) => owned.has(path))),
  }
}

/**
 * The stored feature as ONE target sees it: null when the cap's feature holds
 * only its neighbours' readings (no assignment of this target), else the whole
 * feature. A cap with one target sees what is stored.
 */
export function targetFeature(
  stored: CompositionFieldsFeature | null,
  cap: string,
  targetId: string,
): CompositionFieldsFeature | null {
  if (stored === null) return null
  const target = find(cap, targetId)
  if (target === null || scalarTargetCount(cap) < 2) return stored
  return stored.fields[valuePath(target)] === undefined ? null : stored
}
