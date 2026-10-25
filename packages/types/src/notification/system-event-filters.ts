/**
 * WHICH narrowing filter speaks about WHICH system-event kind — one predicate,
 * consumed by the rule ENGINE and by every rule EDITOR.
 *
 * ── The failure this file exists for ───────────────────────────────────────
 * `NcSystemEventConditionSchema` carries four optional narrowing lists
 * (`deviceIds`, `deviceTypes`, `nodeIds`, `packageNames`) beside a required
 * `kinds` gate. They are not four filters over one vocabulary: each belongs to
 * a FAMILY of kinds and is meaningless outside it. A node going away has no
 * device type; a completed export has no package; `stream-offline` deliberately
 * carries no device type at all (a stream belongs to a camera by construction).
 *
 * The engine applied all four to every kind, so a filter from one family failed
 * a kind from another family CLOSED. The operator's live rule "Eventi di
 * sistema" selected eleven kinds and set `deviceTypes: ['camera']` — the only
 * way to say "only my cameras" about the two liveness kinds — and NINE of the
 * eleven silently stopped being deliverable. Four days of history contained
 * `device-online` and `device-offline` and nothing else, across a window in
 * which agents were restarted and addons were updated.
 *
 * Both editors already computed this scoping, to decide which filter boxes to
 * render; the cap's own docblock already promised it ("Narrow a `device-*` kind
 * to these device TYPES"). Only the engine disagreed, and it disagreed in the
 * destructive direction. So the rule is stated ONCE, here, and the engine and
 * the editors are readers of it rather than three independent authors.
 *
 * ── The direction ─────────────────────────────────────────────────────────
 * Out of family ⇒ the filter is IGNORED, never fail-closed. An editor that
 * hides a box has already told the operator this filter does not speak about
 * these kinds, so honouring it as an exclusion contradicts the only
 * explanation the operator was ever given. Inside its family the filter still
 * narrows, and still fails CLOSED on a subject that cannot produce the identity
 * it tests (a device the mirror cannot name is not evidence of a camera).
 */
import {
  NC_CONSUMABLE_SYSTEM_EVENT_KINDS,
  NC_LEGACY_SYSTEM_EVENT_KINDS,
  type NcSystemEventKind,
} from '../capabilities/notification-rules.cap.js'

const LEGACY_KINDS_WITHOUT_FILTERS = new Set<NcSystemEventKind>(NC_LEGACY_SYSTEM_EVENT_KINDS)

/**
 * A narrowing filter, named by its CONDITION FIELD.
 *
 * The field name and not the editor's label (`devices` / `nodes` / `packages`),
 * because the engine reads `condition.deviceIds` and a guard that compares the
 * two sides has to be able to say which field it is talking about without a
 * translation table in the middle.
 */
export type NcSystemEventFilterKey =
  | 'deviceIds'
  | 'deviceTypes'
  | 'nodeIds'
  | 'packageNames'
  | 'consumableLowPercent'

/**
 * Every filter, for the callers that must cover all of them (guards, tests).
 *
 * `consumableLowPercent` (D642) is not a list but it is a filter in exactly
 * this sense: it belongs to a family of kinds (the consumable pair) and the
 * engine consults it only there. It differs in one way the readers must know —
 * its ABSENCE is not "no narrowing" but the default threshold, because a
 * consumable episode is always judged at SOME threshold.
 */
export const NC_SYSTEM_EVENT_FILTER_KEYS: readonly NcSystemEventFilterKey[] = [
  'deviceIds',
  'deviceTypes',
  'nodeIds',
  'packageNames',
  'consumableLowPercent',
]

/**
 * Does `filter` say anything about `kind`?
 *
 * `false` means the filter is not part of this kind's vocabulary: the engine
 * ignores it and an editor hides its input. It never means "excluded".
 */
export function systemEventFilterApplies(
  kind: NcSystemEventKind,
  filter: NcSystemEventFilterKey,
): boolean {
  // Legacy kinds (tank tail, camera tail) parse for history but match nothing.
  if (LEGACY_KINDS_WITHOUT_FILTERS.has(kind)) return false
  switch (filter) {
    // A device id identifies the subject of liveness, of the operator's
    // switch, of a stream outage (the stream belongs to a camera), of a blind
    // detection session, and of an alarm a camera triggered —
    // `alarm-triggered` is about the CAMERA when a rule set it off and about
    // the panel when a person did, so "only when the gate camera triggers it"
    // stays expressible.
    case 'deviceIds':
      return (
        kind.startsWith('device-') ||
        kind.startsWith('stream-') ||
        kind === 'detection-blind' ||
        kind.startsWith('motion-') ||
        kind.startsWith('recording-') ||
        kind === 'alarm-triggered'
        // export-completed is a SYSTEM fact (D637): the export is the operator's own job, not a device's.
      )
    // The device TYPE is narrower than the device id on purpose. Only the
    // kinds emitted for EVERY device type can be narrowed by it — that is what
    // it is for. A stream is a camera by construction and the intake stamps no
    // type on it, so a type filter here could only ever fail closed.
    // Recording kinds are camera-only by construction (like streams); a type
    // filter would only fail closed, so they are excluded here.
    case 'deviceTypes':
      return kind.startsWith('device-') || kind === 'detection-blind' || kind.startsWith('motion-')
    // Node liveness, the node that lost its accelerators, and the four update
    // kinds — an update is always pinned to the node it landed on (or is
    // available for), which is what makes "only the hub" expressible.
    case 'nodeIds':
      return (
        kind.startsWith('node-') ||
        // A runner the crash breaker gave up on is a fact about ONE node —
        // "tell me when something dies on the hub" is the question an
        // operator asks about it, exactly as for node liveness.
        kind === 'addon-crash-loop' ||
        kind === 'addon-update-available' ||
        kind === 'addon-updated' ||
        kind === 'server-update-available' ||
        // A shell is a fact about ONE node by construction — "only tell me
        // about the hub's image" is precisely the question here.
        kind === 'wrapper-update-available' ||
        kind === 'server-updated' ||
        // A storage location lives on one node; v1 narrows by nodeIds only
        // (no locationIds filter yet).
        kind.startsWith('storage-location-') ||
        // An alert names the node it is about when it has one (a runner, a
        // storage location); an alert without a node fails closed under it.
        kind.startsWith('alert-')
      )
    // Only the update kinds name a package — `node-updating` included: it is
    // the announcement of the `server-updated` that follows (D723). A plain
    // `node-restarting` names none.
    case 'packageNames':
      return (
        kind.endsWith('update-available') ||
        kind === 'addon-updated' ||
        kind === 'node-updating' ||
        kind === 'server-updated'
      )
    // The rule's consumable threshold (D642) speaks only about the consumable
    // band: a battery has the cluster's own threshold, a tank the provider's
    // verdict, and liveness no level at all.
    case 'consumableLowPercent':
      return NC_CONSUMABLE_SYSTEM_EVENT_KINDS.includes(kind)
  }
}

/**
 * Does `filter` say anything about AT LEAST ONE of the selected kinds?
 *
 * The editor's question: a rule selects several kinds at once and renders one
 * filter input for the set, so a filter is shown when any selected kind can be
 * narrowed by it. The kinds it cannot narrow are then simply not narrowed —
 * which is the engine's half of the same rule.
 */
export function systemEventFilterAppliesToAnyKind(
  kinds: readonly NcSystemEventKind[],
  filter: NcSystemEventFilterKey,
): boolean {
  return kinds.some((kind) => systemEventFilterApplies(kind, filter))
}
