/**
 * WHERE each condition is drawn in the admin rule editor (D690; the detection
 * source / zone-crossing placement revised 2026-10-01 — operator ruling).
 *
 * The catalog says which conditions a rule has and which `group` each belongs
 * to; this module decides the page:
 *
 *  - EVERYTHING is always visible. The "Show more configurations" toggle is
 *    gone: an operator looking for a field should not have to know which half
 *    of the editor hides it.
 *  - The detection source and the zone-crossing direction are NOT drawn by
 *    this module at all (`HIDDEN_IDS`). D690 had given them their own
 *    "Advanced" group at the end of THIS (the Conditions) tab — a second,
 *    confusing "Advanced" heading in a dialog that already has one. Since
 *    2026-10-01 they are drawn by `RuleConditionsAdvancedFields`, mounted in
 *    the rule-level Advanced TAB beside the cooldown — one Advanced surface
 *    per rule, not two.
 *  - Minimum confidence is drawn with the object classes (Detections).
 *  - An include/exclude pair is ONE field (R8), drawn where its include id
 *    stands — or its exclude id, when a hub serves only that one.
 *  - Not drawn: the device scope (it has its own tab) and the viewer-drawn
 *    custom zones (R9 — no admin editor exists, and a label over a note was
 *    all this page could offer).
 *
 * Group order and the display group live here; the English headings and their
 * i18n keys are {@link CONDITION_GROUP_LABELS}. A group the catalog introduces
 * that this file does not know is appended, never dropped.
 */
import type { ConditionGroup, GroupedDescriptor } from './notification-condition-fields'
import i18n from '../../i18n/index'

/** A descriptor as the layout reads it. */
export interface LayoutDescriptor extends GroupedDescriptor {
  readonly id: string
}

/**
 * Never drawn by the conditions editor. `source` and `crossing` moved out
 * 2026-10-01: they are drawn by `RuleConditionsAdvancedFields` in the
 * rule-level Advanced tab instead of a second "Advanced" group here.
 */
const HIDDEN_IDS: ReadonlySet<string> = new Set([
  'devices',
  'devicesExclude',
  'customZones',
  'source',
  'crossing',
])

/** Each include/exclude pair drawn as ONE field (D641 classes, D690 zones + faces). */
const SCOPE_PAIRS: readonly (readonly [string, string])[] = [
  ['classes', 'classesExclude'],
  ['zones', 'zonesExclude'],
  ['identities', 'identitiesExclude'],
]

/** Conditions drawn in another group than the catalog's. */
const DISPLAY_GROUP: Readonly<Record<string, string>> = {
  minConfidence: 'class',
}

/** Group headings in page order: the i18n key under `notificationRules.groups.` and the English. */
export const CONDITION_GROUP_LABELS: readonly { readonly id: string; readonly label: string }[] = [
  {
    id: 'system',
    get label() {
      return i18n.t('notificationRules.groups.system')
    },
  },
  {
    id: 'class',
    get label() {
      return i18n.t('notificationRules.groups.class')
    },
  },
  {
    id: 'zones',
    get label() {
      return i18n.t('notificationRules.groups.zones')
    },
  },
  {
    id: 'label',
    get label() {
      return i18n.t('notificationRules.groups.label')
    },
  },
  {
    id: 'quality',
    get label() {
      return i18n.t('notificationRules.groups.quality')
    },
  },
  {
    id: 'scope',
    get label() {
      return i18n.t('notificationRules.groups.scope')
    },
  },
  {
    id: 'device',
    get label() {
      return i18n.t('notificationRules.groups.device')
    },
  },
  {
    id: 'package',
    get label() {
      return i18n.t('notificationRules.groups.package')
    },
  },
  {
    id: 'occupancy',
    get label() {
      return i18n.t('notificationRules.groups.occupancy')
    },
  },
  {
    id: 'audio',
    get label() {
      return i18n.t('notificationRules.groups.audio')
    },
  },
  {
    id: 'schedule',
    get label() {
      return i18n.t('notificationRules.groups.schedule')
    },
  },
]

/** The id a pair member is drawn under: the first of the pair the list holds. */
function pairAnchors(descriptors: readonly LayoutDescriptor[]): ReadonlySet<string> {
  const present = new Set(descriptors.map((d) => d.id))
  const skipped = new Set<string>()
  for (const [include, exclude] of SCOPE_PAIRS) {
    if (present.has(include)) skipped.add(exclude)
  }
  return skipped
}

function displayGroupOf(descriptor: LayoutDescriptor): string {
  return DISPLAY_GROUP[descriptor.id] ?? descriptor.group
}

function fallbackLabel(id: string): string {
  const spaced = id.replace(/[-_]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * The groups the editor draws, in page order, each with the descriptors it
 * holds (catalog order within a group). Empty groups are not returned.
 */
export function layoutConditionGroups<T extends LayoutDescriptor>(
  descriptors: readonly T[],
): readonly ConditionGroup<T>[] {
  const skipped = pairAnchors(descriptors)
  const drawn = descriptors.filter((d) => !HIDDEN_IDS.has(d.id) && !skipped.has(d.id))
  const known = new Set(CONDITION_GROUP_LABELS.map((g) => g.id))
  const groups: ConditionGroup<T>[] = []
  const inGroup = (id: string): readonly T[] => drawn.filter((d) => displayGroupOf(d) === id)

  for (const group of CONDITION_GROUP_LABELS) {
    const members = inGroup(group.id)
    if (members.length > 0) groups.push({ id: group.id, label: group.label, descriptors: members })
  }
  const extras: string[] = []
  for (const d of drawn) {
    const id = displayGroupOf(d)
    if (!known.has(id) && !extras.includes(id)) extras.push(id)
  }
  for (const id of extras) groups.push({ id, label: fallbackLabel(id), descriptors: inGroup(id) })
  return groups
}
