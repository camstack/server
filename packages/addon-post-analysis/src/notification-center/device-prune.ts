/**
 * What the notification centre does to its OWN stores when a device, or a
 * delivery target, is DELETED — as a pure plan. No I/O here: the centre reads
 * the snapshot, this module decides, the centre writes (D-rule: one place that
 * decides, one place that touches the store).
 *
 * ── The rule every branch below defends: NEVER WIDEN ────────────────────────
 *
 * `conditions.devices: []` means "every camera", and an absent
 * `systemEvent.deviceIds` means "every device". A scoped rule that silently
 * became an all-cameras rule is the 2026-08-12 incident. So when the deleted
 * id was the LAST one of a list, the id is KEPT — it matches nothing, the rule
 * fails closed — and the rule is DISABLED, with the reason recorded in the
 * prune ledger so both UIs can say why. Removing the id is then the operator's
 * explicit choice, not ours.
 *
 * The one list that shrinks the other way is `conditions.devicesExclude`
 * (D641): removing an excluded id widens the rule only by a device that can no
 * longer fire, so it is always removed — the last one too, deleting the key.
 *
 * ── Disable ONCE ────────────────────────────────────────────────────────────
 *
 * A last-id case the ledger already recorded (see {@link NcPruneGuard}) is not
 * acted on again, so an operator who re-enables the rule is never overridden
 * on the next tick.
 *
 * ── What is NOT touched ─────────────────────────────────────────────────────
 *
 * Zones (per camera, inert once the camera is gone), liveness, device alerts,
 * snoozes, occupancy and every history store (outbox, artefacts, groups).
 * Those either age out on their own or are a record of what happened.
 */

import type {
  NcActionBinding,
  NcAlarmSettings,
  NcConditions,
  NcRule,
  NcRuleActions,
  NcRulePatch,
  NcRuleTarget,
  TimelapseRule,
  TimelapseRulePatch,
} from '@camstack/types'
import { normalizeNcAction, normalizeNcCapTarget } from '@camstack/types'
import type { NcSummaryRule, NcSummaryRulePatch } from './summary/summary-rule.js'

/** Which store a pruned rule lives in. */
export type NcPruneKind = 'rule' | 'timelapse' | 'summary'

/** What was deleted. */
export type NcPruneSubjectKind = 'device' | 'target'

/**
 * What happened to ONE reference.
 *
 *  - `removed` — the id left the list; the rule still means what it meant.
 *  - `kept-disabled` — it was the last one: kept, and the rule was switched off.
 *  - `kept` — it was the last one, and the rule was ALREADY off. Recorded so an
 *    operator who later re-enables it is not overridden, and so no banner
 *    claims we switched off something the operator had switched off.
 *  - `sequence-removed` — the step was the sequence's last device step, so the
 *    sequence (and every button naming it) went with it.
 *  - `binding-removed` — an inline `do` step on the rule's onTrigger /
 *    onTriggerOff actuated the device; that one binding went, the rule stays.
 */
export type NcPruneOutcome =
  | 'removed'
  | 'kept-disabled'
  | 'kept'
  | 'sequence-removed'
  | 'binding-removed'

/** Who asked: the `DeviceUnregistered` event, or the reload-tick reconcile. */
export type NcPruneSource = 'event' | 'reconcile'

/** One reference that the plan changes — the ledger row, minus its stamp. */
export interface NcPruneNote {
  readonly kind: NcPruneKind
  readonly ruleId: string
  readonly subjectKind: NcPruneSubjectKind
  /** The device id as a decimal string, or the target id. */
  readonly subject: string
  readonly field: string
  readonly outcome: NcPruneOutcome
}

/** The identity the disable-once guard is asked about. */
export interface NcPruneGuardKey {
  readonly kind: NcPruneKind
  readonly ruleId: string
  readonly subjectKind: NcPruneSubjectKind
  readonly subject: string
}

/** True when a last-id case for this key was already recorded (`kept*`). */
export type NcPruneGuard = (key: NcPruneGuardKey) => boolean

export interface NcRulePruneEdit {
  readonly ruleId: string
  readonly patch: NcRulePatch
  readonly notes: readonly NcPruneNote[]
}

export interface NcTimelapsePruneEdit {
  readonly ruleId: string
  readonly patch: TimelapseRulePatch
  /** `generatedByDevice` keys to drop — the device left the rule. */
  readonly forgetDevices: readonly number[]
  readonly notes: readonly NcPruneNote[]
}

export interface NcSummaryPruneEdit {
  readonly ruleId: string
  readonly patch: NcSummaryRulePatch
  readonly notes: readonly NcPruneNote[]
}

/** The alarm panel's lists, as the planner reads them. */
export interface NcPruneAlarmView {
  readonly nonBlocking: NcAlarmSettings['nonBlocking']
  readonly blocking: NcAlarmSettings['blocking']
  readonly secureOnArmOff: NcAlarmSettings['secureOnArmOff']
  readonly announceTargets: readonly string[]
  /** The CURRENT arm's excluded devices. */
  readonly excluded: readonly number[]
}

export interface NcAlarmPruneEdit {
  /** Present only when a list changed. */
  readonly nonBlocking?: NcAlarmSettings['nonBlocking']
  readonly blocking?: NcAlarmSettings['blocking']
  readonly secureOnArmOff?: NcAlarmSettings['secureOnArmOff']
  readonly announceTargets?: readonly string[]
  readonly forgetExcluded: readonly number[]
  /** Every subject an alarm list lost — device ids as strings, or target ids. */
  readonly dropped: readonly string[]
  /** What `dropped` holds. */
  readonly droppedKind: NcPruneSubjectKind
}

export interface NcPrunePlan {
  readonly rules: readonly NcRulePruneEdit[]
  readonly timelapse: readonly NcTimelapsePruneEdit[]
  readonly summary: readonly NcSummaryPruneEdit[]
  readonly alarm: NcAlarmPruneEdit | null
  readonly unmute: readonly number[]
}

/** Everything the planner reads. */
export interface NcPruneSnapshot {
  readonly rules: readonly NcRule[]
  readonly timelapse: readonly TimelapseRule[]
  readonly summary: readonly NcSummaryRule[]
  readonly alarm: NcPruneAlarmView | null
  readonly mutedDeviceIds: readonly number[]
}

// ── small helpers ─────────────────────────────────────────────────────────

/** The outcome of shrinking one list. */
interface NcListVerdict<T> {
  /** Nothing in the list was deleted. */
  readonly untouched: boolean
  /** The shrunk list — only meaningful when `last` is false. */
  readonly next: readonly T[]
  /** The deleted entries found in the list. */
  readonly dead: readonly T[]
  /** Removing them would leave the list EMPTY — keep it and disable instead. */
  readonly last: boolean
}

function judgeList<T>(list: readonly T[], isDead: (entry: T) => boolean): NcListVerdict<T> {
  const dead = list.filter(isDead)
  const next = list.filter((entry) => !isDead(entry))
  return { untouched: dead.length === 0, next, dead, last: dead.length > 0 && next.length === 0 }
}

/**
 * Accumulates one rule's notes and decides whether it must be switched off.
 *
 * A last-id case disables the rule unless the guard already recorded it; when
 * the rule is already off it is recorded as `kept` and nothing is written.
 */
class NcRuleNotes {
  readonly notes: NcPruneNote[] = []
  disable = false

  constructor(
    private readonly kind: NcPruneKind,
    private readonly ruleId: string,
    private readonly subjectKind: NcPruneSubjectKind,
    private readonly enabled: boolean,
    private readonly guard: NcPruneGuard,
  ) {}

  removed(field: string, subjects: readonly string[], outcome: NcPruneOutcome = 'removed'): void {
    for (const subject of subjects) this.notes.push(this.note(field, subject, outcome))
  }

  /** The last reference(s) of a field: kept, and the rule switched off once. */
  kept(field: string, subjects: readonly string[]): void {
    for (const subject of subjects) {
      const key = { kind: this.kind, ruleId: this.ruleId, subjectKind: this.subjectKind, subject }
      if (this.guard(key)) continue
      if (this.enabled) this.disable = true
      this.notes.push(this.note(field, subject, this.enabled ? 'kept-disabled' : 'kept'))
    }
  }

  private note(field: string, subject: string, outcome: NcPruneOutcome): NcPruneNote {
    return {
      kind: this.kind,
      ruleId: this.ruleId,
      subjectKind: this.subjectKind,
      subject,
      field,
      outcome,
    }
  }
}

const deviceSubjects = (ids: readonly number[]): readonly string[] => ids.map((id) => String(id))

// ── devices: ordinary rules ───────────────────────────────────────────────

/** The conditions after a device prune — `null` when no condition list moved. */
function pruneRuleConditions(
  conditions: NcConditions,
  isDead: (id: number) => boolean,
  notes: NcRuleNotes,
): NcConditions | null {
  let next: NcConditions = conditions
  let changed = false
  const devices = conditions.devices
  if (devices !== undefined) {
    const verdict = judgeList(devices, isDead)
    if (verdict.last) notes.kept('conditions.devices', deviceSubjects(verdict.dead))
    else if (!verdict.untouched) {
      next = { ...next, devices: [...verdict.next] }
      changed = true
      notes.removed('conditions.devices', deviceSubjects(verdict.dead))
    }
  }
  // D641: an EXCLUSION shrinks the other way. Dropping a dead id widens the
  // rule by a device that can no longer fire, which changes nothing it can
  // match — so every dead id goes, the last one included, and an emptied list
  // is DELETED (the schema refuses `[]`). No disable, no kept id.
  const excluded = conditions.devicesExclude
  if (excluded !== undefined) {
    const verdict = judgeList(excluded, isDead)
    if (!verdict.untouched) {
      const { devicesExclude: _dead, ...rest } = next
      next = verdict.last ? rest : { ...rest, devicesExclude: [...verdict.next] }
      changed = true
      notes.removed('conditions.devicesExclude', deviceSubjects(verdict.dead))
    }
  }
  const systemEvent = conditions.systemEvent
  if (systemEvent?.deviceIds !== undefined) {
    const verdict = judgeList(systemEvent.deviceIds, isDead)
    if (verdict.last) notes.kept('conditions.systemEvent.deviceIds', deviceSubjects(verdict.dead))
    else if (!verdict.untouched) {
      next = { ...next, systemEvent: { ...systemEvent, deviceIds: [...verdict.next] } }
      changed = true
      notes.removed('conditions.systemEvent.deviceIds', deviceSubjects(verdict.dead))
    }
  }
  const gate = conditions.deviceState
  if (gate !== undefined && isDead(gate.deviceId)) {
    notes.kept('conditions.deviceState', [String(gate.deviceId)])
  }
  const sceneDevice = conditions.scene?.deviceId
  if (sceneDevice !== undefined && isDead(sceneDevice)) {
    notes.kept('conditions.scene', [String(sceneDevice)])
  }
  return changed ? next : null
}

/** A Do binding whose device is dead is dropped; sequence refs are left alone
 *  (shared sequences are pruned on their own store, not per-rule). */
function pruneHookBindings(
  bindings: readonly NcActionBinding[] | undefined,
  field: string,
  isDead: (id: number) => boolean,
  notes: NcRuleNotes,
): { readonly next: readonly NcActionBinding[] | undefined; readonly changed: boolean } {
  if (bindings === undefined) return { next: undefined, changed: false }
  const kept: NcActionBinding[] = []
  let changed = false
  for (const binding of bindings) {
    if (binding.kind === 'sequence') {
      kept.push(binding)
      continue
    }
    if (binding.action.kind === 'cap') {
      const { target } = normalizeNcCapTarget(binding.action)
      if (target.kind === 'devices') {
        const dead = target.ids.filter(isDead)
        if (dead.length === target.ids.length) {
          changed = true
          notes.removed(field, deviceSubjects(dead), 'binding-removed')
          continue
        }
        if (dead.length > 0) {
          changed = true
          notes.removed(field, deviceSubjects(dead), 'binding-removed')
          const alive = target.ids.filter((id) => !isDead(id))
          kept.push({
            ...binding,
            action: normalizeNcAction({
              ...binding.action,
              deviceId: undefined,
              target: { kind: 'devices', ids: alive },
            }),
          })
          continue
        }
      }
    }
    kept.push(binding)
  }
  if (!changed) return { next: bindings, changed: false }
  return { next: kept.length > 0 ? kept : undefined, changed: true }
}

/** The actions after a device prune — `null` when no binding moved. */
function pruneRuleActions(
  actions: NcRuleActions,
  isDead: (id: number) => boolean,
  notes: NcRuleNotes,
): NcRuleActions | null {
  const onActivation = pruneHookBindings(
    actions.onActivation,
    'actions.onActivation',
    isDead,
    notes,
  )
  const onDeactivation = pruneHookBindings(
    actions.onDeactivation,
    'actions.onDeactivation',
    isDead,
    notes,
  )
  const onTrigger = pruneHookBindings(actions.onTrigger, 'actions.onTrigger', isDead, notes)
  const onTriggerOff = pruneHookBindings(
    actions.onTriggerOff,
    'actions.onTriggerOff',
    isDead,
    notes,
  )
  if (
    !onActivation.changed &&
    !onDeactivation.changed &&
    !onTrigger.changed &&
    !onTriggerOff.changed
  ) {
    return null
  }
  return {
    ...(onActivation.next !== undefined ? { onActivation: [...onActivation.next] } : {}),
    ...(onDeactivation.next !== undefined ? { onDeactivation: [...onDeactivation.next] } : {}),
    ...(onTrigger.next !== undefined ? { onTrigger: [...onTrigger.next] } : {}),
    ...(onTriggerOff.next !== undefined ? { onTriggerOff: [...onTriggerOff.next] } : {}),
    ...(actions.buttons !== undefined ? { buttons: actions.buttons } : {}),
  }
}

function planRuleDevices(
  rule: NcRule,
  isDead: (id: number) => boolean,
  guard: NcPruneGuard,
): NcRulePruneEdit | null {
  const notes = new NcRuleNotes('rule', rule.id, 'device', rule.enabled, guard)
  const conditions = pruneRuleConditions(rule.conditions, isDead, notes)
  const actions = rule.actions !== undefined ? pruneRuleActions(rule.actions, isDead, notes) : null
  if (notes.notes.length === 0) return null
  const patch: NcRulePatch = {
    ...(conditions !== null ? { conditions } : {}),
    ...(actions !== null ? { actions } : {}),
    ...(notes.disable ? { enabled: false } : {}),
  }
  return { ruleId: rule.id, patch, notes: notes.notes }
}

// ── devices: timelapse / summary ──────────────────────────────────────────

function planTimelapseDevices(
  rule: TimelapseRule,
  isDead: (id: number) => boolean,
  guard: NcPruneGuard,
): NcTimelapsePruneEdit | null {
  const verdict = judgeList(rule.deviceIds, isDead)
  if (verdict.untouched) return null
  const notes = new NcRuleNotes('timelapse', rule.id, 'device', rule.enabled, guard)
  if (verdict.last) {
    notes.kept('deviceIds', deviceSubjects(verdict.dead))
    if (notes.notes.length === 0) return null
    return {
      ruleId: rule.id,
      patch: notes.disable ? { enabled: false } : {},
      forgetDevices: [],
      notes: notes.notes,
    }
  }
  notes.removed('deviceIds', deviceSubjects(verdict.dead))
  const stamps = rule.generatedByDevice ?? {}
  return {
    ruleId: rule.id,
    patch: { deviceIds: [...verdict.next] },
    forgetDevices: verdict.dead.filter((id) => String(id) in stamps),
    notes: notes.notes,
  }
}

function planSummaryDevices(
  rule: NcSummaryRule,
  isDead: (id: number) => boolean,
  guard: NcPruneGuard,
): NcSummaryPruneEdit | null {
  const verdict = judgeList(rule.deviceIds, isDead)
  if (verdict.untouched) return null
  const notes = new NcRuleNotes('summary', rule.id, 'device', rule.enabled, guard)
  if (verdict.last) {
    notes.kept('deviceIds', deviceSubjects(verdict.dead))
    if (notes.notes.length === 0) return null
    return { ruleId: rule.id, patch: notes.disable ? { enabled: false } : {}, notes: notes.notes }
  }
  notes.removed('deviceIds', deviceSubjects(verdict.dead))
  return { ruleId: rule.id, patch: { deviceIds: [...verdict.next] }, notes: notes.notes }
}

function stripDeadFromLists(
  lists: NcAlarmSettings['nonBlocking'],
  isDead: (id: number) => boolean,
): { readonly next: NcAlarmSettings['nonBlocking']; readonly dead: readonly number[] } {
  const dead = lists.flatMap((list) => list.deviceIds.filter(isDead))
  if (dead.length === 0) return { next: lists, dead }
  return {
    dead,
    next: lists.map((list) => ({
      ...list,
      deviceIds: list.deviceIds.filter((id) => !isDead(id)),
    })),
  }
}

function planAlarmDevices(
  alarm: NcPruneAlarmView | null,
  isDead: (id: number) => boolean,
): NcAlarmPruneEdit | null {
  if (alarm === null) return null
  const nonBlocking = stripDeadFromLists(alarm.nonBlocking, isDead)
  const blocking = stripDeadFromLists(alarm.blocking, isDead)
  const secureOnArmOff = stripDeadFromLists(alarm.secureOnArmOff, isDead)
  const forgetExcluded = alarm.excluded.filter(isDead)
  const deadIds = [...nonBlocking.dead, ...blocking.dead, ...secureOnArmOff.dead, ...forgetExcluded]
  if (deadIds.length === 0) return null
  return {
    dropped: deviceSubjects([...new Set(deadIds)]),
    droppedKind: 'device',
    ...(nonBlocking.dead.length > 0 ? { nonBlocking: nonBlocking.next } : {}),
    ...(blocking.dead.length > 0 ? { blocking: blocking.next } : {}),
    ...(secureOnArmOff.dead.length > 0 ? { secureOnArmOff: secureOnArmOff.next } : {}),
    forgetExcluded,
  }
}

function compact<T>(items: readonly (T | null)[]): readonly T[] {
  return items.filter((item): item is T => item !== null)
}

/**
 * The edits a set of DELETED device ids asks of the centre's stores.
 *
 * Pure and idempotent: planning against the result of applying a plan yields
 * an empty plan (a kept last id is guarded by the ledger row the first plan
 * wrote), so a reconcile tick that finds nothing writes nothing.
 */
export function planDevicePrune(
  snapshot: NcPruneSnapshot,
  deleted: ReadonlySet<number>,
  guard: NcPruneGuard,
): NcPrunePlan {
  const isDead = (id: number): boolean => deleted.has(id)
  return {
    rules: compact(snapshot.rules.map((rule) => planRuleDevices(rule, isDead, guard))),
    timelapse: compact(snapshot.timelapse.map((rule) => planTimelapseDevices(rule, isDead, guard))),
    summary: compact(snapshot.summary.map((rule) => planSummaryDevices(rule, isDead, guard))),
    alarm: planAlarmDevices(snapshot.alarm, isDead),
    unmute: snapshot.mutedDeviceIds.filter(isDead),
  }
}

/** Every device id the centre's stores hold — the reconcile's candidate pool. */
export function referencedDeviceIds(snapshot: NcPruneSnapshot): ReadonlySet<number> {
  const ids = new Set<number>()
  const add = (list: readonly number[] | undefined): void => {
    for (const id of list ?? []) ids.add(id)
  }
  for (const rule of snapshot.rules) {
    const c = rule.conditions
    add(c.devices)
    add(c.devicesExclude)
    add(c.systemEvent?.deviceIds)
    if (c.deviceState !== undefined) ids.add(c.deviceState.deviceId)
    if (c.scene?.deviceId !== undefined) ids.add(c.scene.deviceId)
    // An inline `do` cap step names its device on the rule; a shared sequence's
    // steps live in the sequence store, not here.
    for (const binding of [
      ...(rule.actions?.onTrigger ?? []),
      ...(rule.actions?.onTriggerOff ?? []),
    ]) {
      if (binding.kind !== 'do' || binding.action.kind !== 'cap') continue
      const { target } = normalizeNcCapTarget(binding.action)
      if (target.kind === 'devices') add(target.ids)
    }
  }
  for (const rule of snapshot.timelapse) add(rule.deviceIds)
  for (const rule of snapshot.summary) add(rule.deviceIds)
  for (const list of snapshot.alarm?.nonBlocking ?? []) add(list.deviceIds)
  for (const list of snapshot.alarm?.blocking ?? []) add(list.deviceIds)
  for (const list of snapshot.alarm?.secureOnArmOff ?? []) add(list.deviceIds)
  add(snapshot.alarm?.excluded)
  add(snapshot.mutedDeviceIds)
  return ids
}

// ── targets ───────────────────────────────────────────────────────────────

function planRuleTargets(
  rule: NcRule,
  isDead: (id: string) => boolean,
  guard: NcPruneGuard,
): NcRulePruneEdit | null {
  const notes = new NcRuleNotes('rule', rule.id, 'target', rule.enabled, guard)
  const verdict = judgeList(rule.targets, (t: NcRuleTarget) => isDead(t.targetId))
  const addressesUsers = (rule.targetUsers ?? []).length > 0
  let targets: readonly NcRuleTarget[] | null = null
  const deadIds = verdict.dead.map((t) => t.targetId)
  // A rule with no target AND no targetUsers has nobody to tell — the store
  // refuses to save one (`assertRuleHasAddressee`), so the last target stays.
  if (verdict.last && !addressesUsers) notes.kept('targets', deadIds)
  else if (!verdict.untouched) {
    targets = verdict.next
    notes.removed('targets', deadIds)
  }
  const optOuts = judgeList(rule.disabledTargetIds, isDead)
  if (!optOuts.untouched) notes.removed('disabledTargetIds', optOuts.dead)
  if (notes.notes.length === 0) return null
  const patch: NcRulePatch = {
    ...(targets !== null ? { targets: [...targets] } : {}),
    ...(!optOuts.untouched ? { disabledTargetIds: [...optOuts.next] } : {}),
    ...(notes.disable ? { enabled: false } : {}),
  }
  return { ruleId: rule.id, patch, notes: notes.notes }
}

/** The slice of a timelapse / summary rule a target prune reads. */
interface NcTargetedRule {
  readonly id: string
  readonly enabled: boolean
  readonly targets: readonly NcRuleTarget[]
}

/** The patch both min(1) target lists share — valid for either store. */
interface NcRequiredTargetsPatch {
  readonly targets?: NcRuleTarget[]
  readonly enabled?: boolean
}

interface NcRequiredTargetsEdit {
  readonly patch: NcRequiredTargetsPatch
  readonly notes: readonly NcPruneNote[]
}

/** A min(1) target list (timelapse / summary): shrink, or keep the last + disable. */
function planRequiredTargets(
  kind: 'timelapse' | 'summary',
  rule: NcTargetedRule,
  isDead: (id: string) => boolean,
  guard: NcPruneGuard,
): NcRequiredTargetsEdit | null {
  const verdict = judgeList(rule.targets, (t: NcRuleTarget) => isDead(t.targetId))
  if (verdict.untouched) return null
  const notes = new NcRuleNotes(kind, rule.id, 'target', rule.enabled, guard)
  const deadIds = verdict.dead.map((t) => t.targetId)
  if (verdict.last) {
    notes.kept('targets', deadIds)
    if (notes.notes.length === 0) return null
    return { patch: notes.disable ? { enabled: false } : {}, notes: notes.notes }
  }
  notes.removed('targets', deadIds)
  return { patch: { targets: [...verdict.next] }, notes: notes.notes }
}

/** The edits a set of DELETED target ids asks of the centre's stores. */
export function planTargetPrune(
  snapshot: NcPruneSnapshot,
  deleted: ReadonlySet<string>,
  guard: NcPruneGuard,
): NcPrunePlan {
  const isDead = (id: string): boolean => deleted.has(id)
  const timelapse = compact(
    snapshot.timelapse.map((rule): NcTimelapsePruneEdit | null => {
      const edit = planRequiredTargets('timelapse', rule, isDead, guard)
      return edit === null ? null : { ruleId: rule.id, ...edit, forgetDevices: [] }
    }),
  )
  const summary = compact(
    snapshot.summary.map((rule): NcSummaryPruneEdit | null => {
      const edit = planRequiredTargets('summary', rule, isDead, guard)
      return edit === null ? null : { ruleId: rule.id, ...edit }
    }),
  )
  const announce = snapshot.alarm?.announceTargets ?? []
  const alarm: NcAlarmPruneEdit | null = announce.some(isDead)
    ? {
        announceTargets: announce.filter((id) => !isDead(id)),
        forgetExcluded: [],
        dropped: announce.filter(isDead),
        droppedKind: 'target',
      }
    : null
  return {
    rules: compact(snapshot.rules.map((rule) => planRuleTargets(rule, isDead, guard))),
    timelapse,
    summary,
    alarm,
    unmute: [],
  }
}

/** Every target id the centre's stores hold. */
export function referencedTargetIds(snapshot: NcPruneSnapshot): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const rule of snapshot.rules) {
    for (const target of rule.targets) ids.add(target.targetId)
    for (const id of rule.disabledTargetIds) ids.add(id)
  }
  for (const rule of snapshot.timelapse) for (const t of rule.targets) ids.add(t.targetId)
  for (const rule of snapshot.summary) for (const t of rule.targets) ids.add(t.targetId)
  for (const id of snapshot.alarm?.announceTargets ?? []) ids.add(id)
  return ids
}

/** The subjects a plan acts on — what the reconcile's bound and second read are about. */
export function planSubjects(plan: NcPrunePlan): ReadonlySet<string> {
  const subjects = new Set<string>()
  for (const edit of [...plan.rules, ...plan.timelapse, ...plan.summary]) {
    for (const note of edit.notes) subjects.add(note.subject)
  }
  for (const id of plan.unmute) subjects.add(String(id))
  for (const subject of plan.alarm?.dropped ?? []) subjects.add(subject)
  return subjects
}

/** True when a plan writes nothing and records nothing. */
export function isEmptyPlan(plan: NcPrunePlan): boolean {
  return (
    plan.rules.length === 0 &&
    plan.timelapse.length === 0 &&
    plan.summary.length === 0 &&
    plan.alarm === null &&
    plan.unmute.length === 0
  )
}
