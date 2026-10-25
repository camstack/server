/**
 * Pure aggregator-merge + field-tagging helpers for the device-manager
 * device-details aggregator. Extracted verbatim from
 * `device-manager.addon.ts`. These functions are stateless: they take
 * contributions in and return new wire-shape objects, attaching writer
 * provenance to editable fields. No addon-instance dependency.
 *
 * `mergeAggregates` is re-exported from the addon module to preserve the
 * existing public export surface the test-suite imports.
 */
import { WELL_KNOWN_TAB_MAP } from '@camstack/types'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import type { AggregateSection, AggregateTabDecl, ContributionShape } from './device-meta-types.js'

// ── Aggregator merge ─────────────────────────────────────────────────────────
//
// Concatenate several contributions into a single wire-shape object matching
// `z.infer<typeof SettingsSchemaWithValuesSchema>` (plain mutable arrays).
// Tabs with the same `id` collapse into one; sections within a tab are kept
// in contribution order (contributors self-sort via `order`).
//
// No field-level merge — if two providers target the same `(tab, section)`
// they're concatenated in discovery order. This is intentional: letting the
// aggregator pick a winner would mask accidental collisions and silently
// drop fields.
//
// `ContributionShape` / `AggregateShape` mirror the cap output exactly so no
// assertion is needed when returning from the device-manager handlers.

/**
 * Walk the sections/fields of a contribution and inject `writerCapName` +
 * `writerAddonId` + `source` on each editable field. Readonly fields and
 * structural fields (separator/info/button) pass through untouched. The
 * aggregator is the single place that knows provenance — provider schemas
 * stay clean, UI-bound metadata is attached once at the boundary.
 */
export function tagContribution(
  contribution: ContributionShape,
  capName: string,
  addonId: string,
  kind: 'settings' | 'live',
): ContributionShape {
  const source = kind === 'settings' ? 'settings' : 'live'
  return {
    ...(contribution.tabs ? { tabs: [...contribution.tabs] } : {}),
    sections: contribution.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => tagField(field, capName, addonId, source, kind)),
    })),
  }
}

export function isFieldRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Convert a strict `ConfigUISchemaWithValues` (readonly arrays, typed
 * field union) into the cap wire shape `ContributionShape` (mutable
 * arrays, opaque field records). Required because the cap method z.infer
 * uses mutable arrays — readonly arrays are not assignable to mutable
 * even when structurally identical, so a structural copy bridges the gap
 * without disabling the type checker.
 */
export function toWireShape(input: ConfigUISchemaWithValues): ContributionShape {
  const out: ContributionShape = {
    sections: input.sections.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.titleKey !== undefined ? { titleKey: s.titleKey } : {}),
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.descriptionKey !== undefined ? { descriptionKey: s.descriptionKey } : {}),
      ...(s.style !== undefined ? { style: s.style } : {}),
      ...(s.defaultCollapsed !== undefined ? { defaultCollapsed: s.defaultCollapsed } : {}),
      ...(s.columns !== undefined ? { columns: s.columns } : {}),
      ...(s.tab !== undefined ? { tab: s.tab } : {}),
      // `location: 'top-tab'` hoists the section into a discovered top-
      // level device tab in DeviceDetail. Forgetting to forward it here
      // strips the marker before the client sees it, so the tab never
      // shows up — see `DeviceDetail.tsx` aggregate-driven tab discovery.
      ...(s.location !== undefined ? { location: s.location } : {}),
      ...(s.order !== undefined ? { order: s.order } : {}),
      fields: [...s.fields],
    })),
  }
  if (input.tabs) out.tabs = [...input.tabs]
  return out
}

export function tagField(
  field: unknown,
  capName: string,
  addonId: string,
  source: 'settings' | 'live',
  kind: 'settings' | 'live',
): unknown {
  if (!isFieldRecord(field)) return field
  const f = field
  const structuralTypes = new Set(['separator', 'info', 'button'])
  if (typeof f.type === 'string' && structuralTypes.has(f.type)) return field

  const tagged: Record<string, unknown> = { ...f, source }
  if (kind === 'live' || f.readonlyField === true) {
    tagged.readonlyField = true
  } else {
    tagged.writerCapName = capName
    tagged.writerAddonId = addonId
  }

  // Recurse into composite layouts so nested leaf fields carry the
  // writer routing too. Without this, fields buried inside `'group'`
  // or `'sub-tabs'` containers are surfaced to the UI without a
  // writerCapName/writerAddonId — `findWriter` then can't route the
  // patch back to the cap that produced the field. Records are
  // typed `Record<string, unknown>`, so each step needs an explicit
  // `unknown[]` narrow before `.map` to keep the no-`any` rule happy.
  if (f.type === 'group') {
    const children: readonly unknown[] = Array.isArray(f.fields) ? f.fields : []
    if (children.length > 0) {
      tagged.fields = children.map((child) => tagField(child, capName, addonId, source, kind))
    }
  } else if (f.type === 'sub-tabs') {
    const rawTabs: readonly unknown[] = Array.isArray(f.tabs) ? f.tabs : []
    if (rawTabs.length > 0) {
      tagged.tabs = rawTabs.map((tab) => {
        if (!isFieldRecord(tab)) return tab
        const tabChildren: readonly unknown[] = Array.isArray(tab.fields) ? tab.fields : []
        return {
          ...tab,
          fields: tabChildren.map((child) => tagField(child, capName, addonId, source, kind)),
        }
      })
    }
  }
  return tagged
}

export function mergeAggregates(parts: readonly ContributionShape[]): ContributionShape {
  const tabDecls = new Map<string, AggregateTabDecl>()
  const sections: AggregateSection[] = []
  // Section ids must be UNIQUE in the rendered aggregate — the UI keys panels by
  // id and can't show two sections with the same id. A provider exposed through
  // TWO registrations contributes its sections through both aggregation passes:
  // e.g. the orchestrator registers itself for `pipeline-orchestrator` (system,
  // collected by `collectSystemDeviceContributions`) AND `camera-pipeline-config`
  // (device wrapper, collected by the binding pass), so its
  // `getDeviceSettingsContribution` sections arrive twice. Keep the FIRST
  // occurrence (binding-driven results precede systemResults in `parts`, and D12
  // prefers the device-bound contribution) and drop later id-collisions.
  const seenSectionIds = new Set<string>()

  for (const part of parts) {
    if (part.tabs) {
      for (const t of part.tabs) {
        if (!tabDecls.has(t.id)) tabDecls.set(t.id, t)
      }
    }
    for (const s of part.sections) {
      if (s.id !== undefined) {
        if (seenSectionIds.has(s.id)) continue
        seenSectionIds.add(s.id)
      }
      sections.push(s)
    }
  }

  // Auto-derive tab declarations from section references when contributors
  // don't emit one explicitly. Every tab id referenced in a section's `tab`
  // field gets a declaration — if the id matches a well-known tab
  // (general/detection/streaming/recording/…) the canonical label+icon+order
  // is used; otherwise we fall back to the raw id as label with a generic
  // icon. Ensures the UI has everything it needs to render the tab bar
  // from a single payload — no extra lookup, no duplicate source of truth.
  for (const s of sections) {
    const tabId = s.tab ?? 'general'
    if (tabDecls.has(tabId)) continue
    const known = WELL_KNOWN_TAB_MAP[tabId as keyof typeof WELL_KNOWN_TAB_MAP]
    if (known) {
      tabDecls.set(tabId, {
        id: known.id,
        label: known.label,
        icon: known.icon,
        order: known.order,
      })
    } else {
      tabDecls.set(tabId, { id: tabId, label: tabId, icon: 'wrench', order: 100 })
    }
  }

  sections.sort((a, b) => {
    const tabA = a.tab ?? 'general'
    const tabB = b.tab ?? 'general'
    if (tabA !== tabB) {
      const orderA = tabDecls.get(tabA)?.order ?? 100
      const orderB = tabDecls.get(tabB)?.order ?? 100
      if (orderA !== orderB) return orderA - orderB
      return tabA.localeCompare(tabB)
    }
    return (a.order ?? 0) - (b.order ?? 0)
  })

  const sortedTabs = [...tabDecls.values()].toSorted((a, b) => (a.order ?? 100) - (b.order ?? 100))
  const out: ContributionShape = { sections }
  if (sortedTabs.length > 0) out.tabs = sortedTabs
  return out
}
