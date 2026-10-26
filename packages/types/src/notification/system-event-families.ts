/**
 * WHICH FAMILY every system-event kind belongs to, and which narrowing filters
 * each family may carry: one table, read by the hub validator, by `ruleKindOf`
 * and by both rule editors (D637).
 *
 * A system rule used to be one editor for thirty-one kinds and five filters.
 * "Eventi di sistema" carried battery kinds under a liveness `deviceTypes` filter
 * and went silent for two weeks (D636). The three families are three questions:
 * about devices, about the installation, and about the alarm panel. A rule
 * answers one of them. The engine never needed to know, and it still does not:
 * a mixed stored rule keeps firing. Only AUTHORING is strict.
 *
 * The legacy `camera-*` tail has no family (`null`). It is parsed, never produced,
 * never offered.
 */
import {
  NC_ALARM_SYSTEM_EVENT_KINDS,
  type NcSystemEventCondition,
  type NcSystemEventKind,
} from '../capabilities/notification-rules.cap.js'
import { NC_SYSTEM_EVENT_FILTER_KEYS, type NcSystemEventFilterKey } from './system-event-filters.js'

export const NC_SYSTEM_EVENT_FAMILIES = ['device-events', 'system', 'alarm'] as const
export type NcSystemEventFamily = (typeof NC_SYSTEM_EVENT_FAMILIES)[number]

export function isSystemEventFamily(value: string): value is NcSystemEventFamily {
  return NC_SYSTEM_EVENT_FAMILIES.some((family) => family === value)
}

/** Total over the enum: a kind added to the cap without a family fails tsc here. */
export const NC_SYSTEM_EVENT_FAMILY: Readonly<
  Record<NcSystemEventKind, NcSystemEventFamily | null>
> = {
  'device-online': 'device-events',
  'device-offline': 'device-events',
  'device-disabled': 'device-events',
  'device-enabled': 'device-events',
  'device-battery-low': 'device-events',
  'device-battery-normal': 'device-events',
  'device-consumable-low': 'device-events',
  'device-consumable-normal': 'device-events',
  'stream-online': 'device-events',
  'stream-offline': 'device-events',
  'detection-blind': 'device-events',
  'motion-noisy': 'device-events',
  'motion-calm': 'device-events',
  'package-llm-silent': 'device-events',
  'package-llm-answered': 'device-events',
  'recording-stalled': 'device-events',
  'recording-healthy': 'device-events',
  'recording-degraded': 'device-events',
  'device-attention-required': 'device-events',
  'device-attention-resolved': 'device-events',
  'node-online': 'system',
  'node-offline': 'system',
  'node-restarting': 'system',
  'node-updating': 'system',
  'node-inference-unavailable': 'system',
  'addon-crash-loop': 'system',
  'addon-update-available': 'system',
  'addon-updated': 'system',
  'server-update-available': 'system',
  'server-updated': 'system',
  'wrapper-update-available': 'system',
  'backup-completed': 'system',
  'export-completed': 'system',
  'alert-critical': 'system',
  'alert-error': 'system',
  'alert-critical-resolved': 'system',
  'rule-broken': 'system',
  'rule-repaired': 'system',
  'storage-location-low': 'system',
  'storage-location-critical': 'system',
  'storage-location-ok': 'system',
  'alarm-triggered': 'alarm',
  'alarm-armed': 'alarm',
  'alarm-disarmed': 'alarm',
  'alarm-arming': 'alarm',
  'alarm-arm-refused': 'alarm',
  'alarm-pending': 'alarm',
  'alarm-rearmed': 'alarm',
  'alarm-sensor-bypass': 'alarm',
  'alarm-check-failed': 'alarm',
  'camera-online': null,
  'camera-offline': null,
  'camera-disabled': null,
  'camera-enabled': null,
}

/** Read by NAME, for kinds that arrive as plain strings (a newer hub, the viewer's mirror). */
const FAMILY_BY_NAME: ReadonlyMap<string, NcSystemEventFamily | null> = new Map(
  Object.entries(NC_SYSTEM_EVENT_FAMILY),
)

/** A condition field that can narrow or exclude a system subject. */
export type NcSystemEventConditionFilterKey = NcSystemEventFilterKey | 'excludeDeviceIds'

export const NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS: readonly NcSystemEventConditionFilterKey[] = [
  ...NC_SYSTEM_EVENT_FILTER_KEYS,
  'excludeDeviceIds',
]

/**
 * The filters a family may carry. The base filters are the union of
 * `systemEventFilterApplies` over the family's kinds (the spec pins that
 * equality). `excludeDeviceIds` is a device-events filter only: an alarm is
 * narrowed to the camera that triggered it and excludes nothing.
 */
export const NC_SYSTEM_EVENT_FAMILY_FILTERS: Readonly<
  Record<NcSystemEventFamily, readonly NcSystemEventConditionFilterKey[]>
> = {
  'device-events': ['deviceIds', 'excludeDeviceIds', 'deviceTypes', 'consumableLowPercent'],
  system: ['nodeIds', 'packageNames'],
  alarm: ['deviceIds'],
}

/** A themed set of kinds as both editors list them. `label` is an English fallback. */
export interface NcSystemEventKindGroupSpec {
  readonly id: string
  readonly family: NcSystemEventFamily
  readonly label: string
  readonly kinds: readonly NcSystemEventKind[]
}

export const NC_SYSTEM_EVENT_KIND_GROUP_SPECS: readonly NcSystemEventKindGroupSpec[] = [
  {
    id: 'device-state',
    family: 'device-events',
    label: 'Device state',
    kinds: ['device-offline', 'device-online', 'device-disabled', 'device-enabled'],
  },
  {
    id: 'streams',
    family: 'device-events',
    label: 'Streams',
    kinds: ['stream-offline', 'stream-online'],
  },
  {
    id: 'battery',
    family: 'device-events',
    label: 'Battery',
    kinds: ['device-battery-low', 'device-battery-normal'],
  },
  {
    id: 'consumables',
    family: 'device-events',
    label: 'Consumables',
    kinds: ['device-consumable-low', 'device-consumable-normal'],
  },
  {
    id: 'detection-blind',
    family: 'device-events',
    label: 'Detecting nothing',
    kinds: ['detection-blind'],
  },
  {
    id: 'motion-noise',
    family: 'device-events',
    label: 'Motion without a subject',
    kinds: ['motion-noisy', 'motion-calm'],
  },
  {
    id: 'package-llm',
    family: 'device-events',
    label: 'Package confirm',
    kinds: ['package-llm-silent', 'package-llm-answered'],
  },
  {
    id: 'recording',
    family: 'device-events',
    label: 'Recording',
    kinds: ['recording-stalled', 'recording-healthy', 'recording-degraded'],
  },
  {
    id: 'device-attention',
    family: 'device-events',
    label: 'Needs attention',
    kinds: ['device-attention-required', 'device-attention-resolved'],
  },
  {
    id: 'nodes',
    family: 'system',
    label: 'Nodes',
    kinds: ['node-offline', 'node-online', 'node-restarting', 'node-inference-unavailable'],
  },
  // Two groups since D708: an addon the hub stopped restarting and an addon
  // that is behind are acted on by different people at different moments, so
  // the scheduled summary sends them as two notifications — and a summary
  // section IS a kind group (`state-model.ts`).
  {
    id: 'addons',
    family: 'system',
    label: 'Addons stopped',
    kinds: ['addon-crash-loop'],
  },
  {
    id: 'addon-updates',
    family: 'system',
    label: 'Addon updates',
    kinds: ['addon-update-available', 'addon-updated'],
  },
  {
    id: 'updates',
    family: 'system',
    label: 'Server & container updates',
    // `node-updating` sits beside the update it announces (D723): it is the
    // first half of `server-updated`, and the operator who wants one wants both.
    kinds: [
      'server-update-available',
      'node-updating',
      'server-updated',
      'wrapper-update-available',
    ],
  },
  {
    id: 'backups-exports',
    family: 'system',
    label: 'Backups & exports',
    kinds: ['backup-completed', 'export-completed'],
  },
  {
    id: 'storage',
    family: 'system',
    label: 'Storage locations',
    kinds: ['storage-location-low', 'storage-location-critical', 'storage-location-ok'],
  },
  {
    id: 'alerts',
    family: 'system',
    label: 'Alerts',
    kinds: ['alert-critical', 'alert-error', 'alert-critical-resolved'],
  },
  {
    id: 'rule-health',
    family: 'system',
    label: 'Notification rules',
    kinds: ['rule-broken', 'rule-repaired'],
  },
  {
    id: 'alarm',
    family: 'alarm',
    label: 'Alarm',
    kinds: NC_ALARM_SYSTEM_EVENT_KINDS,
  },
]

export function systemEventKindsOfFamily(
  family: NcSystemEventFamily,
): readonly NcSystemEventKind[] {
  return NC_SYSTEM_EVENT_KIND_GROUP_SPECS.filter((g) => g.family === family).flatMap((g) => g.kinds)
}

/** The kind names on an UNTYPED condition, or `undefined` when it has none. */
export function systemEventKindNamesOf(condition: unknown): readonly string[] | undefined {
  if (typeof condition !== 'object' || condition === null || !('kinds' in condition))
    return undefined
  const kinds: unknown = condition.kinds
  if (!Array.isArray(kinds)) return undefined
  return kinds.filter((kind): kind is string => typeof kind === 'string')
}

export type NcSystemEventFamilyVerdict =
  | { readonly kind: 'family'; readonly family: NcSystemEventFamily }
  | { readonly kind: 'mixed' }

/**
 * One family, or `mixed`. Mixed covers kinds that span families, a legacy kind,
 * a kind this build does not know (it fails toward read-only and never toward
 * editable), and an empty selection (nothing to decide on).
 */
export function systemEventFamilyOf(kindNames: readonly string[]): NcSystemEventFamilyVerdict {
  const families = new Set<NcSystemEventFamily>()
  for (const name of kindNames) {
    const family = FAMILY_BY_NAME.get(name)
    if (family === undefined || family === null) return { kind: 'mixed' }
    families.add(family)
  }
  const [only] = [...families]
  return families.size === 1 && only !== undefined
    ? { kind: 'family', family: only }
    : { kind: 'mixed' }
}

export type NcSystemEventFamilyProblem =
  | { readonly code: 'no-kinds' }
  | { readonly code: 'legacy-kind'; readonly kind: NcSystemEventKind }
  | { readonly code: 'mixed-families'; readonly families: readonly NcSystemEventFamily[] }
  | {
      readonly code: 'filter-outside-family'
      readonly filter: NcSystemEventConditionFilterKey
      readonly family: NcSystemEventFamily
    }

/**
 * Why the hub refuses this condition on a new or updated rule. Empty = accepted.
 * Families are reported in `NC_SYSTEM_EVENT_FAMILIES` order, and filters in
 * `NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS` order, so a refusal reads the same
 * every time.
 */
export function systemEventFamilyProblems(
  condition: NcSystemEventCondition | undefined,
): readonly NcSystemEventFamilyProblem[] {
  if (condition === undefined || condition.kinds.length === 0) return [{ code: 'no-kinds' }]
  const problems: NcSystemEventFamilyProblem[] = []
  const present = new Set<NcSystemEventFamily>()
  for (const kind of condition.kinds) {
    const family = NC_SYSTEM_EVENT_FAMILY[kind]
    if (family === null) problems.push({ code: 'legacy-kind', kind })
    else present.add(family)
  }
  const families = NC_SYSTEM_EVENT_FAMILIES.filter((f) => present.has(f))
  if (families.length > 1) problems.push({ code: 'mixed-families', families })
  const [family] = families
  if (families.length !== 1 || family === undefined) return problems
  const allowed = NC_SYSTEM_EVENT_FAMILY_FILTERS[family]
  for (const filter of NC_SYSTEM_EVENT_CONDITION_FILTER_KEYS) {
    if (condition[filter] !== undefined && !allowed.includes(filter)) {
      problems.push({ code: 'filter-outside-family', filter, family })
    }
  }
  return problems
}

export function describeSystemEventFamilyProblem(problem: NcSystemEventFamilyProblem): string {
  switch (problem.code) {
    case 'no-kinds':
      return 'a system-event rule needs at least one event kind'
    case 'legacy-kind':
      return `'${problem.kind}' is a legacy kind and cannot be authored`
    case 'mixed-families':
      return `event kinds span ${problem.families.join(' + ')} — one rule per family`
    case 'filter-outside-family':
      return `filter '${problem.filter}' is not allowed on a ${problem.family} rule`
  }
}
