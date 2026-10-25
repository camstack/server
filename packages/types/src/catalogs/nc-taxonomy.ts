/**
 * Notification-Center taxonomy — the fixed vocabulary the NC rule editor
 * offers as pickers instead of free text. Derived (never hand-listed) from the
 * single `EVENT_TAXONOMY` dictionary so it stays in lockstep with every other
 * taxonomy surface (timeline, filters, event page).
 *
 * Three buckets, mapped onto the rule editor's `stringList` conditions:
 *   - `videoClasses` → detection classes (person / vehicle / animal + subs)
 *     for the `classes` / `classesExclude` conditions.
 *   - `audioKinds`   → audio-analyzer sub kinds (`audio-scream`, …) shown in
 *     the same class picker, grouped under an Audio header.
 *   - `labels`       → sensor + control taxonomy kinds (doorbell / contact /
 *     lock / …) for the `sensorKinds` device-event condition.
 *
 * Each entry carries `parentKind` so the client can group video subs under
 * their macro and sensor/control kinds under their category. This surface is
 * served ADDITIVELY on the `nc.getConditionCatalog` bridge response — no cap
 * method, no codegen — so it ships train-free with an addon deploy.
 */
import { z } from 'zod'
import { EVENT_TAXONOMY } from './event-taxonomy.js'

/** One selectable taxonomy value: a stable kind id + display label + parent. */
export const NcTaxonomyEntrySchema = z.object({
  /** Stable kind id (e.g. 'person', 'car', 'audio-scream', 'doorbell'). */
  kind: z.string(),
  /** English fallback label (the UI translates via the event-kind i18n key). */
  label: z.string(),
  /** Macro/category parent for grouping ('car' → 'vehicle'); null for a top. */
  parentKind: z.string().nullable(),
})
export type NcTaxonomyEntry = z.infer<typeof NcTaxonomyEntrySchema>

/** The complete NC picker taxonomy — three grouped buckets. */
export const NcTaxonomySchema = z.object({
  videoClasses: z.array(NcTaxonomyEntrySchema),
  audioKinds: z.array(NcTaxonomyEntrySchema),
  labels: z.array(NcTaxonomyEntrySchema),
})
export type NcTaxonomy = z.infer<typeof NcTaxonomySchema>

function toEntry(kind: string, label: string, parentKind: string | null): NcTaxonomyEntry {
  return { kind, label, parentKind }
}

/**
 * Build the NC taxonomy from `EVENT_TAXONOMY`. Insertion order is preserved
 * (macros before their subs), which the client relies on for stable grouping.
 */
export function buildNcTaxonomy(): NcTaxonomy {
  const all = Object.values(EVENT_TAXONOMY)
  return {
    videoClasses: all
      .filter((e) => e.category === 'detection')
      .map((e) => toEntry(e.kind, e.label, e.parentKind)),
    audioKinds: all
      .filter((e) => e.category === 'audio' && e.level === 'sub')
      .map((e) => toEntry(e.kind, e.label, e.parentKind)),
    labels: all
      .filter((e) => e.category === 'sensor' || e.category === 'control')
      .map((e) => toEntry(e.kind, e.label, e.parentKind)),
  }
}

/** The frozen NC taxonomy, derived once from the taxonomy dictionary. */
export const NC_TAXONOMY: NcTaxonomy = Object.freeze(buildNcTaxonomy())
