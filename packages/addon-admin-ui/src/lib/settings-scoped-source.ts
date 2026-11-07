/**
 * The scoped data source of the generic settings panel (D986 §7).
 *
 * An addon has no addon-level form: it serves one schema per (capability, scope) and
 * `addonSettings.listScopedSettings` names them. The panel draws ONE pane per addon, so this
 * module selects which declarations a surface shows, merges their hydrated schemas into one, and
 * remembers which (cap, scope) owns each field key so a Save lands on the right row.
 */
import {
  collectHydratedFieldEntries,
  type ConfigTabDeclaration,
  type ConfigUISchemaWithValues,
  type ScopedSettingsDeclaration,
  type ScopedSettingsScope,
} from '@camstack/types'
import type { SettingsFieldScope } from './settings-field-scope'

/** The (capability, scope) that stores a field. */
export interface ScopedTarget {
  readonly cap: string
  readonly scope: ScopedSettingsScope
}

/** A declaration with only the sections this surface shows (each section id at most once). */
export interface SelectedDeclaration extends ScopedTarget {
  readonly sectionIds: readonly string[]
}

export interface SelectDeclarationsInput {
  readonly declarations: readonly ScopedSettingsDeclaration[]
  /** `perNode` -> the `node` scope; `cluster` -> the `cluster` scope; absent -> every scope. */
  readonly fieldScope?: SettingsFieldScope
  /** Only this capability's declarations. */
  readonly capability?: string
  readonly allowSectionIds?: readonly string[]
  readonly omitSectionIds?: readonly string[]
}

function scopeMatches(scope: ScopedSettingsScope, fieldScope: SettingsFieldScope | undefined) {
  if (fieldScope === undefined) return true
  return fieldScope === 'perNode' ? scope === 'node' : scope === 'cluster'
}

/**
 * Which declarations to fetch, and which of their sections to keep. A section id served by two
 * (cap, scope) pairs is shown once — the first, in declaration order. A declaration left with no
 * section is dropped, so nothing is fetched for it.
 */
export function selectDeclarations(input: SelectDeclarationsInput): readonly SelectedDeclaration[] {
  const allow = input.allowSectionIds ? new Set(input.allowSectionIds) : null
  const omit = input.omitSectionIds ? new Set(input.omitSectionIds) : null
  const seen = new Set<string>()
  const out: SelectedDeclaration[] = []
  for (const decl of input.declarations) {
    if (!scopeMatches(decl.scope, input.fieldScope)) continue
    if (input.capability !== undefined && decl.cap !== input.capability) continue
    const owned = decl.sectionIds.filter((id) => {
      if (seen.has(id)) return false
      seen.add(id)
      if (allow !== null && !allow.has(id)) return false
      return omit === null || !omit.has(id)
    })
    if (owned.length > 0) out.push({ cap: decl.cap, scope: decl.scope, sectionIds: owned })
  }
  return out
}

/** A selected declaration with the hydrated form its (cap, scope) served. */
export interface FetchedDeclaration {
  readonly declaration: SelectedDeclaration
  readonly form: ConfigUISchemaWithValues
}

export interface MergedScopedForm {
  readonly form: ConfigUISchemaWithValues
  /** Field key -> the (cap, scope) that stores it. */
  readonly keyTargets: Readonly<Record<string, ScopedTarget>>
}

/** One form out of the fetched declarations, in declaration order, owned sections only. */
export function mergeFetched(fetched: readonly FetchedDeclaration[]): MergedScopedForm {
  const sections: ConfigUISchemaWithValues['sections'] = []
  const tabs = new Map<string, ConfigTabDeclaration>()
  const keyTargets: Record<string, ScopedTarget> = {}
  for (const { declaration, form } of fetched) {
    const owned = new Set(declaration.sectionIds)
    const kept = form.sections.filter((section) => owned.has(section.id))
    sections.push(...kept)
    for (const tab of form.tabs ?? []) if (!tabs.has(tab.id)) tabs.set(tab.id, tab)
    for (const key of collectHydratedFieldEntries({ sections: kept }).keys()) {
      if (!(key in keyTargets)) keyTargets[key] = { cap: declaration.cap, scope: declaration.scope }
    }
  }
  return {
    form: { ...(tabs.size > 0 ? { tabs: [...tabs.values()] } : {}), sections },
    keyTargets,
  }
}

/** A pending patch split per (cap, scope): one `updateScopedSettings` call each. */
export interface ScopedPatchGroup extends ScopedTarget {
  readonly patch: Record<string, unknown>
}

/** Group a patch by owning target. A key nothing owns is returned apart, never dropped. */
export function groupPatchByTarget(
  patch: Readonly<Record<string, unknown>>,
  keyTargets: Readonly<Record<string, ScopedTarget>>,
): { readonly groups: readonly ScopedPatchGroup[]; readonly unowned: readonly string[] } {
  const groups = new Map<string, { target: ScopedTarget; patch: Record<string, unknown> }>()
  const unowned: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    const target = keyTargets[key]
    if (target === undefined) {
      unowned.push(key)
      continue
    }
    const id = `${target.cap}\u0000${target.scope}`
    const group = groups.get(id) ?? { target, patch: {} }
    group.patch[key] = value
    groups.set(id, group)
  }
  return {
    groups: [...groups.values()].map((g) => ({ ...g.target, patch: g.patch })),
    unowned,
  }
}
