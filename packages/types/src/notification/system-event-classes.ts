/**
 * D906 — system events that come in PAIRS are one CLASS: a "went bad" edge and
 * a "came back" edge of the same condition (a stream offline / back online, a
 * recording stalled / writing again, a rule broken / repaired).
 *
 * Nothing new is STORED: a rule keeps listing edge kinds, and a class is the
 * set of its edges. What the class decides:
 *
 *  - an IMMEDIATE system rule that selects a class is told about BOTH edges.
 *    A stored instant rule listing only one edge of a class is read as the
 *    whole class (`withSystemEventClasses`) — the operator asked for both
 *    fronts, and a rule that heard "offline" and never "back online" left
 *    every outage open-ended on the phone.
 *  - a SCHEDULED STATE SUMMARY (`systemEventDelivery.mode: 'summary'`) reads a
 *    class as a SNAPSHOT of the bad state at the scheduled time — never edges,
 *    never recoveries — so it is NOT widened. The summary already reports a
 *    state per kind group regardless of which edge was selected (D647).
 *
 * One-edge kinds (a node restarting, an update available, a backup done, the
 * alarm's transitions) stay single. Pure.
 */
import type {
  NcSystemEventCondition,
  NcSystemEventDelivery,
  NcSystemEventKind,
} from '../capabilities/notification-rules.cap.js'
import { type NcSystemEventFamily, NC_SYSTEM_EVENT_FAMILY } from './system-event-families.js'

export interface NcSystemEventClassSpec {
  readonly id: string
  readonly family: NcSystemEventFamily
  /** The editor's one checkbox. */
  readonly label: string
  /** The edges into the bad state. */
  readonly bad: readonly NcSystemEventKind[]
  /** The edges out of it. */
  readonly recovery: readonly NcSystemEventKind[]
  /** What the class means on a SCHEDULED summary: the bad state, as a list. */
  readonly snapshotLabel: string
  /**
   * The state-summary section that snapshots the bad state, or `null` when the
   * summary has no source for this class (it then reports nothing for it).
   */
  readonly snapshotSection: string | null
}

export const NC_SYSTEM_EVENT_CLASS_SPECS: readonly NcSystemEventClassSpec[] = [
  {
    id: 'device-connectivity',
    family: 'device-events',
    label: 'Device connectivity (offline / back online)',
    bad: ['device-offline'],
    recovery: ['device-online'],
    snapshotLabel: 'Devices offline now',
    snapshotSection: 'device-state',
  },
  {
    id: 'device-switch',
    family: 'device-events',
    label: 'Device switched off / back on',
    bad: ['device-disabled'],
    recovery: ['device-enabled'],
    snapshotLabel: 'Devices switched off now',
    snapshotSection: 'device-state',
  },
  {
    id: 'stream-connectivity',
    family: 'device-events',
    label: 'Stream connectivity (offline / back online)',
    bad: ['stream-offline'],
    recovery: ['stream-online'],
    snapshotLabel: 'Streams offline now',
    snapshotSection: 'streams',
  },
  {
    id: 'battery',
    family: 'device-events',
    label: 'Battery (low / back to normal)',
    bad: ['device-battery-low'],
    recovery: ['device-battery-normal'],
    snapshotLabel: 'Batteries low now',
    snapshotSection: 'battery',
  },
  {
    id: 'consumables',
    family: 'device-events',
    label: 'Consumables (low / replaced)',
    bad: ['device-consumable-low'],
    recovery: ['device-consumable-normal'],
    snapshotLabel: 'Consumables low now',
    snapshotSection: 'consumables',
  },
  {
    id: 'motion-noise',
    family: 'device-events',
    label: 'Motion without a subject (constant / calm again)',
    bad: ['motion-noisy'],
    recovery: ['motion-calm'],
    snapshotLabel: 'Cameras with constant motion now',
    snapshotSection: null,
  },
  {
    id: 'package-llm-confirm',
    family: 'device-events',
    label: 'Package confirm (not answering / answering again)',
    bad: ['package-llm-silent'],
    recovery: ['package-llm-answered'],
    snapshotLabel: 'Cameras whose package confirm is not answering',
    snapshotSection: null,
  },
  {
    id: 'recording-health',
    family: 'device-events',
    label: 'Recording health (stalled or degraded / recording again)',
    bad: ['recording-stalled', 'recording-degraded'],
    recovery: ['recording-healthy'],
    snapshotLabel: 'Recordings stalled now',
    snapshotSection: null,
  },
  {
    id: 'device-attention',
    family: 'device-events',
    label: 'Device needs attention (raised / resolved)',
    bad: ['device-attention-required'],
    recovery: ['device-attention-resolved'],
    snapshotLabel: 'Devices needing attention now',
    snapshotSection: null,
  },
  {
    id: 'node-connectivity',
    family: 'system',
    label: 'Node connectivity (offline / back online)',
    bad: ['node-offline'],
    recovery: ['node-online'],
    snapshotLabel: 'Nodes offline now',
    snapshotSection: 'nodes',
  },
  {
    id: 'storage-space',
    family: 'system',
    label: 'Storage space (low or critical / ok again)',
    bad: ['storage-location-low', 'storage-location-critical'],
    recovery: ['storage-location-ok'],
    snapshotLabel: 'Storage locations low now',
    snapshotSection: null,
  },
  {
    id: 'critical-alerts',
    family: 'system',
    label: 'Critical alerts (raised / resolved)',
    bad: ['alert-critical'],
    recovery: ['alert-critical-resolved'],
    snapshotLabel: 'Critical alerts open now',
    snapshotSection: null,
  },
  {
    id: 'rule-health',
    family: 'system',
    label: 'Rule health (broken / repaired)',
    bad: ['rule-broken'],
    recovery: ['rule-repaired'],
    snapshotLabel: 'Notification rules broken now',
    snapshotSection: null,
  },
]

const CLASS_BY_KIND: ReadonlyMap<string, NcSystemEventClassSpec> = new Map(
  NC_SYSTEM_EVENT_CLASS_SPECS.flatMap((spec) =>
    [...spec.bad, ...spec.recovery].map((kind) => [kind, spec] as const),
  ),
)

/** Every edge of a class: what an instant rule selecting it listens to. */
export function systemEventClassKinds(spec: NcSystemEventClassSpec): readonly NcSystemEventKind[] {
  return [...spec.bad, ...spec.recovery]
}

/** The class a kind belongs to, or `undefined` for a one-edge kind. */
export function systemEventClassOf(kind: string): NcSystemEventClassSpec | undefined {
  return CLASS_BY_KIND.get(kind)
}

/** Is this kind a RECOVERY edge of some class? */
export function isSystemEventRecoveryKind(kind: string): boolean {
  return systemEventClassOf(kind)?.recovery.some((k) => k === kind) ?? false
}

/** The classes of ONE family, for that family's editor. */
export function systemEventClassesFor(
  family: NcSystemEventFamily,
): readonly NcSystemEventClassSpec[] {
  return NC_SYSTEM_EVENT_CLASS_SPECS.filter((spec) => spec.family === family)
}

/**
 * A kind list with the OTHER front of every class it touches: a bad edge
 * brings the class's recovery, a recovery brings the class's bad edges. A
 * sibling bad edge is never added by a bad edge — a rule on
 * `storage-location-critical` does not start hearing `storage-location-low`.
 * Input order is kept, each added edge right after the kind that brought it.
 * Kinds of no class (and legacy names) pass through.
 */
export function expandSystemEventClasses(kinds: readonly NcSystemEventKind[]): NcSystemEventKind[] {
  const out: NcSystemEventKind[] = []
  const seen = new Set<string>()
  const push = (kind: NcSystemEventKind): void => {
    if (seen.has(kind)) return
    seen.add(kind)
    out.push(kind)
  }
  const listed = new Set<string>(kinds)
  for (const kind of kinds) {
    push(kind)
    const spec = systemEventClassOf(kind)
    if (spec === undefined) continue
    // A recovery brings the bad edges only when the rule lists none of them,
    // so a widened rule reads back unchanged (idempotent).
    const hasBad = spec.bad.some((k) => listed.has(k))
    const isBad = spec.bad.some((k) => k === kind)
    if (isBad) for (const edge of spec.recovery) push(edge)
    else if (!hasBad) for (const edge of spec.bad) push(edge)
  }
  return out
}

/** The part of a rule {@link withSystemEventClasses} reads. */
export interface NcSystemEventClassSubject {
  readonly delivery: string
  readonly conditions: { readonly systemEvent?: NcSystemEventCondition }
  readonly systemEventDelivery?: NcSystemEventDelivery
}

/** Does this rule speak per EVENT (not a scheduled summary)? */
function isInstantSystemRule(rule: NcSystemEventClassSubject): boolean {
  if (rule.delivery !== 'system-event') return false
  return rule.systemEventDelivery?.mode !== 'summary'
}

/**
 * An INSTANT system rule with each class it touches completed with both edges;
 * the rule itself (same object) when there is nothing to add, a summary rule,
 * or a rule spanning families (`mixed` stays read-only, D637). A copy, never a
 * mutation.
 */
export function withSystemEventClasses<T extends NcSystemEventClassSubject>(rule: T): T {
  const condition = rule.conditions.systemEvent
  if (condition === undefined || !isInstantSystemRule(rule)) return rule
  const families = new Set(condition.kinds.map((kind) => NC_SYSTEM_EVENT_FAMILY[kind]))
  if (families.size !== 1 || families.has(null)) return rule
  const kinds = expandSystemEventClasses(condition.kinds)
  if (kinds.length === condition.kinds.length) return rule
  return {
    ...rule,
    conditions: { ...rule.conditions, systemEvent: { ...condition, kinds } },
  }
}
