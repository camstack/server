/**
 * condition-taxonomy — pure mapping from a notification-rule condition id to a
 * grouped picker model, driven by the server's `NcTaxonomy` (video classes +
 * audio kinds + sensor/control labels).
 *
 * WHY IT LIVES HERE
 * ─────────────────
 * It was written in the viewer and is the correct model — macro→sub grouping,
 * translated headers with an English fallback, free text kept as a deliberate
 * escape hatch. The admin UI had none of it and rendered every list condition
 * as a free-text tag input, so an operator had to TYPE `person` / `vehicle`
 * from memory and type a zone's *id* rather than pick its name, and a typo
 * produced a rule that silently never matched.
 *
 * Copying it into the admin UI would leave two implementations of "which
 * vocabulary backs which condition" free to drift. It is UI-framework-free by
 * construction, so it is hoisted here — beside `degrade-engine.ts`, the
 * existing precedent for pure notification logic in this package — and both
 * surfaces consume it.
 *
 * A condition with no fixed vocabulary (identities, plates, raw event tokens,
 * admin zone ids) returns `null` and keeps its free-text input. Conditions WITH
 * a vocabulary keep free text too, as an escape hatch for values the taxonomy
 * does not know.
 */
import type { NcTaxonomy, NcTaxonomyEntry } from '../catalogs/nc-taxonomy.js'

/** One selectable option inside a picker group. */
export interface TaxonomyOption {
  readonly value: string
  readonly label: string
}

/** A labelled group of options (rendered under a translated header). */
export interface TaxonomyGroup {
  /** i18n sub-key under `v2.nc.rules.editor.taxonomy.` */
  readonly key: string
  /** English fallback header when the i18n key is missing. */
  readonly fallbackLabel: string
  readonly options: readonly TaxonomyOption[]
}

/** The picker model for one condition, or `null` when it stays free-text. */
export interface TaxonomyPicker {
  readonly groups: readonly TaxonomyGroup[]
}

/** Condition ids that render the class picker (video macros/subs + audio). */
const CLASS_CONDITION_IDS: ReadonlySet<string> = new Set(['classes', 'classesExclude'])
/** Condition ids that render the sensor/control label picker. */
const LABEL_CONDITION_IDS: ReadonlySet<string> = new Set(['sensorKinds'])
/**
 * Condition ids whose class scope is a COUNT, not a match — they get the
 * MACRO-ONLY vocabulary.
 *
 * Every other class condition goes through the engine's `expandClassSelector`,
 * which expands a macro to its subs and matches a sub against the detection's
 * own class. Occupancy does not: it reads `byClass[className]` out of the
 * ZoneAnalytics snapshot, and that record is keyed on MACROS only (the executor
 * maps COCO onto the macro and drops the rest). A sub-type therefore names a key
 * that does not exist — the counter is 0 forever and the rule cannot fire.
 *
 * Live cost, 2026-08-12: two rules on device 102 were authored with `car`
 * because this picker offered the whole taxonomy. They were silent for a day.
 */
const COUNT_CLASS_CONDITION_IDS: ReadonlySet<string> = new Set(['occupancy'])

function toOption(entry: NcTaxonomyEntry): TaxonomyOption {
  return { value: entry.kind, label: entry.label }
}

/** Mutable accumulator for a group being built. */
interface GroupAccumulator {
  fallbackLabel: string
  readonly options: TaxonomyOption[]
}

/**
 * Group detection entries by their macro. A macro entry (`parentKind === null`)
 * opens its own group and is itself the first option in it; subs fall under
 * their `parentKind`. First-appearance order is preserved, which is why
 * `buildNcTaxonomy` emits macros before their subs.
 */
function groupVideoClasses(videoClasses: readonly NcTaxonomyEntry[]): TaxonomyGroup[] {
  const order: string[] = []
  const byKey = new Map<string, GroupAccumulator>()
  const ensure = (key: string, fallbackLabel: string): GroupAccumulator => {
    const existing = byKey.get(key)
    if (existing !== undefined) return existing
    const created: GroupAccumulator = { fallbackLabel, options: [] }
    byKey.set(key, created)
    order.push(key)
    return created
  }
  for (const entry of videoClasses) {
    const key = entry.parentKind ?? entry.kind
    // A macro names its own group; a sub inherits the (possibly not-yet-seen)
    // macro's label lazily — the macro row itself supplies the real header.
    const fallback = entry.parentKind === null ? entry.label : key
    const group = ensure(key, fallback)
    group.options.push(toOption(entry))
    if (entry.parentKind === null) group.fallbackLabel = entry.label
  }
  return order.flatMap((key) => {
    const group = byKey.get(key)
    return group === undefined
      ? []
      : [{ key, fallbackLabel: group.fallbackLabel, options: group.options }]
  })
}

/** Group sensor/control labels by their category parent (`sensor` | `control`). */
function groupLabels(labels: readonly NcTaxonomyEntry[]): TaxonomyGroup[] {
  const order: string[] = []
  const byKey = new Map<string, TaxonomyOption[]>()
  for (const entry of labels) {
    const key = entry.parentKind ?? 'other'
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, [toOption(entry)])
      order.push(key)
    } else {
      existing.push(toOption(entry))
    }
  }
  return order.flatMap((key) => {
    const options = byKey.get(key)
    return options === undefined ? [] : [{ key, fallbackLabel: key, options }]
  })
}

/**
 * Build the grouped picker model for a condition id, or `null` when the
 * condition has no fixed vocabulary (→ free-text tag input).
 */
export function pickerForCondition(
  conditionId: string,
  taxonomy: NcTaxonomy | undefined,
): TaxonomyPicker | null {
  if (!taxonomy) return null

  if (CLASS_CONDITION_IDS.has(conditionId)) {
    const groups = groupVideoClasses(taxonomy.videoClasses)
    if (taxonomy.audioKinds.length > 0) {
      groups.push({
        key: 'audio',
        fallbackLabel: 'Audio',
        options: taxonomy.audioKinds.map(toOption),
      })
    }
    return groups.length > 0 ? { groups } : null
  }

  if (COUNT_CLASS_CONDITION_IDS.has(conditionId)) {
    // ONE flat group: the macro rows are the entire vocabulary, so grouping
    // them under themselves would render a header per option.
    const options = taxonomy.videoClasses.filter((e) => e.parentKind === null).map(toOption)
    return options.length > 0
      ? { groups: [{ key: 'macro', fallbackLabel: 'Classes', options }] }
      : null
  }

  if (LABEL_CONDITION_IDS.has(conditionId)) {
    const groups = groupLabels(taxonomy.labels)
    return groups.length > 0 ? { groups } : null
  }

  return null
}

/** The taxonomy group the class picker appends the audio kinds under. */
const AUDIO_GROUP_KEY = 'audio'

/**
 * The class picker a RULE's class scope uses: {@link pickerForCondition}'s
 * `classes` vocabulary WITHOUT the audio group (R13, D690).
 *
 * A detection rule that picked a sound there became the legacy one-sample audio
 * rule and broke itself; sounds are authored on a Sound rule
 * (`conditions.audio`). The plain `classes` picker keeps the audio group for
 * the surfaces where a sound IS a class — a snooze, a report, the simulator.
 */
export function pickerForRuleClasses(taxonomy: NcTaxonomy | undefined): TaxonomyPicker | null {
  const picker = pickerForCondition('classes', taxonomy)
  if (picker === null) return null
  const groups = picker.groups.filter((group) => group.key !== AUDIO_GROUP_KEY)
  return groups.length > 0 ? { groups } : null
}

/** An audio kind (`audio-*`) — the one prefix every sound class carries. */
export function isAudioClassName(name: string): boolean {
  return name.trim().toLowerCase().startsWith(`${AUDIO_GROUP_KEY}-`)
}

/** All option values across a picker's groups (for custom-value detection). */
export function knownValues(picker: TaxonomyPicker): ReadonlySet<string> {
  const set = new Set<string>()
  for (const group of picker.groups) {
    for (const option of group.options) set.add(option.value)
  }
  return set
}

// ── Base / advanced split ───────────────────────────────────────────

/**
 * The condition ids shown in the ALWAYS-VISIBLE area of a rule editor. Every
 * other catalog descriptor is advanced and lives behind an expander.
 *
 * Shared for the same reason as the picker model: two surfaces disagreeing
 * about what counts as "basic" is a worse outcome than either choice.
 */
export const NC_BASE_CONDITION_KEYS = ['devices', 'classes'] as const
export type NcBaseConditionKey = (typeof NC_BASE_CONDITION_KEYS)[number]

const BASE_CONDITION_SET: ReadonlySet<string> = new Set(NC_BASE_CONDITION_KEYS)

/** True when a condition key belongs to the BASE surface. */
export function isBaseConditionKey(key: string): boolean {
  return BASE_CONDITION_SET.has(key)
}
