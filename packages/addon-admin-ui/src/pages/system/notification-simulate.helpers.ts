/**
 * Pure helpers for the notification SIMULATOR (`/system/notifications?tab=simulate`).
 *
 * The simulator injects a synthetic event through the same intake seam the
 * tracker and the sensor ingest use, and reports what every rule did with it.
 * This file owns everything about that surface that is not React:
 *
 *   - the TRIGGER vocabulary and the delivery each trigger rides,
 *   - the form state, and the wire payload built from it,
 *   - {@link prefillFromRule} — the rule → form derivation behind the per-rule
 *     "Test" button,
 *   - the one-shot prefill handoff between the Rules tab and this one,
 *   - a defensive parser for the answer.
 *
 * WHY THE PAYLOAD IS A HAND-WRITTEN INTERFACE
 * ───────────────────────────────────────────
 * The authority is `NcTestEventInputSchema` in
 * `packages/addon-post-analysis/src/notification-center/test-event.ts`. It is an
 * ADDON-internal schema reached through the generic `addons.custom` action,
 * whose input and output are both `z.unknown()` — there is no generated client
 * type to infer from, and the admin UI may not import an addon's source. So the
 * shapes are mirrored here, once, next to the parser that checks the answer at
 * runtime ({@link parseSimulateResult}): a drift shows up as "the hub answered
 * something this build cannot read", never as a silently wrong render.
 */

import type { NcDelivery, NcOccupancyCondition, NcRule } from '@camstack/types'
import i18n from '../../i18n/index'

// ── Trigger vocabulary ──────────────────────────────────────────────

/**
 * One value per subject kind the intake seam accepts. Mirrors `TriggerSchema`
 * in `test-event.ts`.
 */
export type NcSimulateTrigger =
  | 'object-event'
  | 'track-end'
  | 'device-event'
  | 'package-event'
  | 'audio-event'
  | 'occupancy-event'

export interface NcSimulateTriggerOption {
  readonly value: NcSimulateTrigger
  readonly label: string
  /** What the trigger IS, in one line — shown under the select. */
  readonly hint: string
}

/**
 * The six triggers, in the order an operator meets them.
 *
 * The kind decides which DELIVERY a rule must declare to be a candidate at all,
 * so picking the wrong one is the most common reason a rule "does not fire" —
 * which is why it is an explicit choice rather than something inferred from the
 * fields below it.
 */
export const NC_SIMULATE_TRIGGERS: readonly NcSimulateTriggerOption[] = [
  {
    value: 'object-event',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.objectLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.objectHint')
    },
  },
  {
    value: 'track-end',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.trackEndLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.trackEndHint')
    },
  },
  {
    value: 'device-event',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.deviceEventLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.deviceEventHint')
    },
  },
  {
    value: 'package-event',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.packageEventLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.packageEventHint')
    },
  },
  {
    value: 'audio-event',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.audioEventLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.audioEventHint')
    },
  },
  {
    value: 'occupancy-event',
    get label() {
      return i18n.t('helpers.notificationSimulateHelpers.occupancyEdgeLabel')
    },
    get hint() {
      return i18n.t('helpers.notificationSimulateHelpers.occupancyEdgeHint')
    },
  },
]

/** Narrow a raw `<select>` string to a known trigger (no cast — L3). */
export function parseSimulateTrigger(value: string): NcSimulateTrigger | undefined {
  return NC_SIMULATE_TRIGGERS.find((o) => o.value === value)?.value
}

/**
 * The delivery a trigger rides — the mirror of `deliveryForKind` in
 * `event-intake.ts`. A rule declaring anything else is not a candidate, which
 * is the answer to most "it did not fire", so the UI states it BEFORE running.
 */
export function deliveryForTrigger(trigger: NcSimulateTrigger): NcDelivery {
  if (trigger === 'object-event' || trigger === 'audio-event') return 'immediate'
  if (trigger === 'occupancy-event') return 'device-event'
  return trigger
}

/**
 * The provenance a trigger's subject carries in PRODUCTION, when the operator
 * has not said otherwise. Always ABSENT — the server stamps it, and the whole
 * value of this tester is that it does not pre-empt the server.
 *
 * Worth stating because the obvious guess is wrong and was made here once: an
 * `audio-event` does NOT carry `source: 'audio'`. `subjectFromAudioEvent`
 * stamps `pipeline`, because audio analysis is a pipeline product and not a
 * linked-sensor slice. The `audio` source belongs to the D62 audio MARKER —
 * a synthetic track, which arrives on `track-end`.
 *
 * Pre-filling `audio` here would have made a rule gated on `source: audio`
 * match a simulated audio episode that a real one could never satisfy: a test
 * that passes where production fails, which is the one outcome a tester must
 * never produce.
 */
export function defaultSourceForTrigger(_trigger: NcSimulateTrigger): '' | NcSimulateSource {
  return ''
}

// ── The wire payload (mirrors NcTestEventInputSchema) ────────────────

export type NcSimulateCrossingDirection = 'enter' | 'exit'
export type NcSimulatePackagePhase = 'delivered' | 'picked-up'
export type NcSimulateSource = 'pipeline' | 'onboard' | 'sensor' | 'audio'
export type NcSimulateStill = 'live' | 'none'

/** Normalized 0..1 rectangle, top-left origin — the subject bbox space. */
export interface NcSimulateBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface NcSimulateCrossing {
  readonly zoneId: string
  readonly direction: NcSimulateCrossingDirection
}

export interface NcSimulateOccupancy {
  readonly zoneId?: string
  readonly zoneName?: string
  readonly className?: string
  readonly count: number
  readonly previousCount: number
  readonly occupied: boolean
  readonly threshold: number
}

export interface NcSimulateInput {
  readonly trigger: NcSimulateTrigger
  readonly deviceId: number
  readonly sourceDeviceId?: number
  readonly classNames: readonly string[]
  readonly label?: string
  readonly confidence?: number
  readonly labelConfidence?: number
  readonly importance?: number
  readonly dwellSeconds?: number
  readonly zones: readonly string[]
  readonly crossing?: NcSimulateCrossing
  readonly sensorKind?: string
  readonly eventType?: string
  readonly packagePhase?: NcSimulatePackagePhase
  readonly source?: NcSimulateSource
  readonly bbox?: NcSimulateBbox
  readonly occupancy?: NcSimulateOccupancy
  readonly timestamp?: number
  readonly onlyRuleId?: string
  readonly bypassCooldown: boolean
  readonly bypassMute: boolean
  readonly runActions: boolean
  readonly still: NcSimulateStill
}

// ── The form ────────────────────────────────────────────────────────

export interface NcSimulateBboxForm {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface NcSimulateOccupancyForm {
  readonly zoneId: string
  readonly zoneName: string
  readonly className: string
  readonly count: number
  readonly previousCount: number
  readonly occupied: boolean
  readonly threshold: number
}

/**
 * The editable form state.
 *
 * Every OPTIONAL quality field is `number | undefined` rather than a number with
 * a zero default, because ABSENT is a distinct, testable state: a
 * `minConfidence` condition FAILS on a subject that carries no confidence, and
 * a simulator that could not express that would lie about the most common
 * fail-closed condition in the catalog.
 *
 * `''` plays the same role for the string fields, and is normalised away in
 * {@link buildSimulateInput}.
 */
export interface NcSimulateFormState {
  readonly trigger: NcSimulateTrigger
  /** The CAMERA the event is attributed to. `null` = nothing chosen yet. */
  readonly deviceId: number | null
  /** DEVICE-EVENT: the linked device whose state changed. */
  readonly sourceDeviceId: number | null
  readonly classNames: readonly string[]
  readonly label: string
  readonly confidence: number | undefined
  readonly labelConfidence: number | undefined
  readonly importance: number | undefined
  readonly dwellSeconds: number | undefined
  readonly zones: readonly string[]
  readonly crossingEnabled: boolean
  readonly crossingZoneId: string
  readonly crossingDirection: NcSimulateCrossingDirection
  readonly sensorKind: string
  readonly eventType: string
  /** `''` = absent. */
  readonly packagePhase: '' | NcSimulatePackagePhase
  /** `''` = absent (the subject reads as `pipeline`). */
  readonly source: '' | NcSimulateSource
  readonly bboxEnabled: boolean
  readonly bbox: NcSimulateBboxForm
  readonly occupancy: NcSimulateOccupancyForm
  /** `<input type="datetime-local">` value. `''` = now. */
  readonly timestampLocal: string
  /** Evaluate ONLY this rule — what the per-rule Test button sets. */
  readonly onlyRuleId: string
  readonly bypassCooldown: boolean
  readonly bypassMute: boolean
  readonly runActions: boolean
  readonly still: NcSimulateStill
}

/** A centred half-frame box — something a `customZones` polygon can overlap. */
const DEFAULT_BBOX: NcSimulateBboxForm = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }

const DEFAULT_OCCUPANCY: NcSimulateOccupancyForm = {
  zoneId: '',
  zoneName: '',
  className: '',
  count: 1,
  previousCount: 0,
  occupied: true,
  threshold: 1,
}

/** A blank simulation. */
export function emptySimulateForm(): NcSimulateFormState {
  return {
    trigger: 'object-event',
    deviceId: null,
    sourceDeviceId: null,
    classNames: [],
    label: '',
    confidence: undefined,
    labelConfidence: undefined,
    importance: undefined,
    dwellSeconds: undefined,
    zones: [],
    crossingEnabled: false,
    crossingZoneId: '',
    crossingDirection: 'enter',
    sensorKind: '',
    eventType: '',
    packagePhase: '',
    source: '',
    bboxEnabled: false,
    bbox: DEFAULT_BBOX,
    occupancy: DEFAULT_OCCUPANCY,
    timestampLocal: '',
    onlyRuleId: '',
    // Both default OFF: a suppressed cooldown and a mute are ANSWERS the result
    // panel reports, and bypassing them by default would hide the two most
    // common reasons a live rule is quiet.
    bypassCooldown: false,
    bypassMute: false,
    // OFF: running a rule's sequences actuates real devices.
    runActions: false,
    still: 'live',
  }
}

/** True when the form can be run at all (a camera is the only hard requirement). */
export function isSimulateFormValid(form: NcSimulateFormState): boolean {
  return form.deviceId !== null
}

/**
 * Read a raw numeric `<input>` value.
 *
 * `''` → `undefined` (ABSENT), never `0`. `Number('')` is `0`, so the obvious
 * one-liner would turn "I left this blank" into "the subject carries a
 * confidence of zero" — a different, and passing, condition.
 */
export function parseOptionalNumberInput(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** `<input type="datetime-local">` value → epoch ms; `''`/unparsable → undefined. */
export function parseLocalDateTime(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

/** Epoch ms → the `datetime-local` value shape (local clock, minute precision). */
export function toLocalDateTimeValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

/**
 * Assemble the wire payload.
 *
 * Returns `null` when no camera is chosen — the caller disables the button, and
 * a payload with a fabricated device id would be answered honestly about a
 * camera the operator never picked.
 *
 * Fields that do not belong to the chosen trigger are DROPPED rather than sent
 * and ignored: a package phase riding an object event would show up in the log
 * line of an event that has no phase.
 */
export function buildSimulateInput(form: NcSimulateFormState): NcSimulateInput | null {
  if (form.deviceId === null) return null
  const trigger = form.trigger
  const timestamp = parseLocalDateTime(form.timestampLocal)
  const label = form.label.trim()
  const sensorKind = form.sensorKind.trim()
  const eventType = form.eventType.trim()
  const onlyRuleId = form.onlyRuleId.trim()

  const isDeviceEvent = trigger === 'device-event'
  const isOccupancy = trigger === 'occupancy-event'

  return {
    trigger,
    deviceId: form.deviceId,
    ...(isDeviceEvent && form.sourceDeviceId !== null && form.sourceDeviceId !== form.deviceId
      ? { sourceDeviceId: form.sourceDeviceId }
      : {}),
    classNames: [...form.classNames],
    ...(label.length > 0 ? { label } : {}),
    ...(form.confidence !== undefined ? { confidence: form.confidence } : {}),
    ...(form.labelConfidence !== undefined ? { labelConfidence: form.labelConfidence } : {}),
    ...(form.importance !== undefined ? { importance: form.importance } : {}),
    ...(form.dwellSeconds !== undefined ? { dwellSeconds: form.dwellSeconds } : {}),
    zones: [...form.zones],
    ...(trigger === 'object-event' && form.crossingEnabled
      ? { crossing: { zoneId: form.crossingZoneId, direction: form.crossingDirection } }
      : {}),
    ...(isDeviceEvent && sensorKind.length > 0 ? { sensorKind } : {}),
    ...(isDeviceEvent && eventType.length > 0 ? { eventType } : {}),
    ...(trigger === 'package-event' && form.packagePhase !== ''
      ? { packagePhase: form.packagePhase }
      : {}),
    ...(form.source !== '' ? { source: form.source } : {}),
    ...(form.bboxEnabled ? { bbox: { ...form.bbox } } : {}),
    ...(isOccupancy ? { occupancy: buildOccupancy(form.occupancy) } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(onlyRuleId.length > 0 ? { onlyRuleId } : {}),
    bypassCooldown: form.bypassCooldown,
    bypassMute: form.bypassMute,
    runActions: form.runActions,
    still: form.still,
  }
}

function buildOccupancy(form: NcSimulateOccupancyForm): NcSimulateOccupancy {
  const zoneId = form.zoneId.trim()
  const zoneName = form.zoneName.trim()
  const className = form.className.trim()
  return {
    ...(zoneId.length > 0 ? { zoneId } : {}),
    ...(zoneName.length > 0 ? { zoneName } : {}),
    ...(className.length > 0 ? { className } : {}),
    count: Math.max(0, Math.round(form.count)),
    previousCount: Math.max(0, Math.round(form.previousCount)),
    occupied: form.occupied,
    threshold: Math.max(1, Math.round(form.threshold)),
  }
}

// ── Rule → form (the per-rule "Test" button) ────────────────────────

/**
 * Nudge a threshold to a value that PASSES it.
 *
 * A rule asking for `minConfidence: 0.7` must be simulated at something above
 * 0.7, not at 0.7-minus-a-float-error, and the number has to read like something
 * a detector would produce. Clamped to 1 so a rule with a floor of 1 still gets
 * a legal value.
 */
function justAbove(floor: number): number {
  return Math.min(1, Math.round((floor + 0.05) * 100) / 100)
}

/**
 * Which trigger a rule's delivery corresponds to.
 *
 * `deliveryForTrigger` is many-to-one, so the inverse needs the rule's
 * conditions to choose:
 *   - `immediate` is `object-event` unless every class the rule names is an
 *     audio class (`audio-…`), which only an audio episode carries;
 *   - `device-event` is the sensor path unless the rule carries an `occupancy`
 *     condition, which only an occupancy edge can satisfy.
 */
export function triggerForRule(rule: NcRule): NcSimulateTrigger {
  if (rule.delivery === 'immediate') {
    const classes = rule.conditions.classes ?? []
    return classes.length > 0 && classes.every((c) => c.startsWith('audio-'))
      ? 'audio-event'
      : 'object-event'
  }
  if (rule.delivery === 'device-event') {
    return rule.conditions.occupancy === undefined ? 'device-event' : 'occupancy-event'
  }
  if (rule.delivery === 'track-end') return 'track-end'
  return 'package-event'
}

/**
 * Seed the simulator with an event that SHOULD satisfy the rule.
 *
 * This is the function most likely to drift from the condition set — a new
 * condition is added server-side, the form gains a field, and this derivation
 * quietly keeps prefilling the old subset. It is pure and unit-tested for that
 * reason.
 *
 * What it deliberately does NOT set: the run flags. A cooldown suppression and
 * a mute are the two most common reasons a working rule is silent, and the
 * result panel REPORTS both — bypassing them by default would hide the answer
 * the operator came for.
 */
export function prefillFromRule(rule: NcRule): NcSimulateFormState {
  const base = emptySimulateForm()
  const c = rule.conditions
  const trigger = triggerForRule(rule)
  const zones = c.zones?.ids ?? []
  const label = c.identities?.[0] ?? c.labelEquals?.[0] ?? c.plates?.values?.[0]
  const crossingDirection: NcSimulateCrossingDirection | undefined =
    c.crossing === 'exit' ? 'exit' : c.crossing === undefined ? undefined : 'enter'
  const packagePhase: '' | NcSimulatePackagePhase =
    trigger !== 'package-event' ? '' : c.packagePhase === 'picked-up' ? 'picked-up' : 'delivered'

  return {
    ...base,
    trigger,
    deviceId: c.devices?.[0] ?? null,
    classNames: [...(c.classes ?? [])],
    ...(label !== undefined ? { label } : {}),
    ...(c.minConfidence !== undefined ? { confidence: justAbove(c.minConfidence) } : {}),
    ...(c.minLabelConfidence !== undefined
      ? { labelConfidence: justAbove(c.minLabelConfidence) }
      : {}),
    ...(c.minImportance !== undefined ? { importance: justAbove(c.minImportance) } : {}),
    ...(c.minDwellSeconds !== undefined ? { dwellSeconds: Math.round(c.minDwellSeconds) + 1 } : {}),
    zones: [...zones],
    // A crossing only exists on an object event; a track carries none.
    ...(trigger === 'object-event' && crossingDirection !== undefined
      ? {
          crossingEnabled: true,
          crossingZoneId: zones[0] ?? '',
          crossingDirection,
        }
      : {}),
    ...(c.sensorKinds?.[0] !== undefined ? { sensorKind: c.sensorKinds[0] } : {}),
    ...(c.eventTypeTokens?.[0] !== undefined ? { eventType: c.eventTypeTokens[0] } : {}),
    packagePhase,
    // `any` is "no restriction" — reproducing it as an authored source would
    // narrow the simulation the rule deliberately left open. With no source
    // condition at all the trigger's own production default applies.
    source:
      c.source !== undefined && c.source !== 'any' ? c.source : defaultSourceForTrigger(trigger),
    // A `customZones` rule can only be satisfied by a subject that HAS a bbox.
    ...(c.customZones !== undefined && c.customZones.length > 0 ? { bboxEnabled: true } : {}),
    ...(c.occupancy !== undefined ? { occupancy: occupancyFromCondition(c.occupancy) } : {}),
    onlyRuleId: rule.id,
  }
}

/**
 * Turn an occupancy CONDITION into the edge that satisfies it.
 *
 * The condition states a threshold and an operator; the event states the count
 * before and after. Each op has exactly one edge that passes it:
 *   - `became-occupied` / `>=` → the count arrives AT the threshold from below,
 *   - `became-free` → it falls to zero from the threshold,
 *   - `<=` → it falls TO the threshold from one above.
 */
export function occupancyFromCondition(condition: NcOccupancyCondition): NcSimulateOccupancyForm {
  const threshold = Math.max(1, Math.round(condition.count))
  const zoneId = condition.zoneId ?? ''
  const className = condition.className ?? ''
  const shared = { zoneId, zoneName: '', className, threshold }
  if (condition.op === 'became-free') {
    return { ...shared, count: 0, previousCount: threshold, occupied: false }
  }
  if (condition.op === '<=') {
    const count = Math.max(0, Math.round(condition.count))
    return { ...shared, count, previousCount: count + 1, occupied: count > 0 }
  }
  return { ...shared, count: threshold, previousCount: Math.max(0, threshold - 1), occupied: true }
}

// ── Caveats the simulator cannot express ────────────────────────────

/** One condition the simulation cannot fully reproduce, and why. */
export interface NcSimulateCaveat {
  readonly conditionId: string
  readonly note: string
}

/**
 * Conditions on a rule that a synthetic subject cannot satisfy by itself.
 *
 * Rendered next to the prefilled form so a "did not match" on one of these
 * reads as a known limit rather than a broken rule. Silence here would send the
 * operator hunting a bug in a rule that is fine.
 */
export function simulateCaveats(rule: NcRule): readonly NcSimulateCaveat[] {
  const out: NcSimulateCaveat[] = []
  if (rule.conditions.deviceState !== undefined) {
    out.push({
      conditionId: 'deviceState',
      note: i18n.t('helpers.notificationSimulateHelpers.caveatDevice', {
        deviceId: rule.conditions.deviceState.deviceId,
      }),
    })
  }
  if (rule.conditions.scene !== undefined) {
    out.push({
      conditionId: 'scene',
      note: i18n.t('helpers.notificationSimulateHelpers.caveatScene', {
        state: rule.conditions.scene.requiredState,
      }),
    })
  }
  if (rule.conditions.customZones !== undefined && rule.conditions.customZones.length > 0) {
    out.push({
      conditionId: 'customZones',
      note: i18n.t('helpers.notificationSimulateHelpers.caveatZones'),
    })
  }
  return out
}

// ── The Rules → Simulate handoff ────────────────────────────────────

/** Everything the Test button hands the simulate tab about one rule. */
export interface NcSimulatePrefill {
  readonly form: NcSimulateFormState
  /** What the simulation cannot reproduce for this rule — rendered, not hidden. */
  readonly caveats: readonly NcSimulateCaveat[]
  /** The rule's name, so the tab can say what it was seeded from. */
  readonly ruleName: string
}

/** The whole rule → simulate derivation, in one call. */
export function prefillForRule(rule: NcRule): NcSimulatePrefill {
  return { form: prefillFromRule(rule), caveats: simulateCaveats(rule), ruleName: rule.name }
}

/**
 * The prefill parked by the rules list for the simulate tab to pick up.
 *
 * `AdminTabs` coordinates the active tab through `?tab=<id>`, and the panel is
 * cold-mounted on the switch — so the form state cannot be handed down through
 * props, and a full form does not belong in a URL. This is a one-shot box in
 * module scope: parked by the Test button, PEEKED by the panel's state
 * initializer (which React re-invokes under StrictMode, so it must be
 * idempotent) and cleared once the panel has mounted.
 */
let parkedPrefill: NcSimulatePrefill | null = null

export function parkSimulatePrefill(prefill: NcSimulatePrefill): void {
  parkedPrefill = prefill
}

/** Read the parked prefill WITHOUT consuming it (safe to call twice). */
export function peekSimulatePrefill(): NcSimulatePrefill | null {
  return parkedPrefill
}

/** Drop the parked prefill — called once the panel has taken it. */
export function clearSimulatePrefill(): void {
  parkedPrefill = null
}

// ── The answer ──────────────────────────────────────────────────────

export type NcSimulateCooldown = 'n/a' | 'clear' | 'suppressed' | 'bypassed'
export type NcSimulateStillVerdict = 'live' | 'none' | 'unavailable' | 'unattachable'

export interface NcSimulateOutcome {
  readonly ruleId: string
  readonly ruleName: string
  readonly matched: boolean
  readonly failedCondition?: string
  readonly matchedOn?: readonly string[]
  readonly cooldown: NcSimulateCooldown
  readonly enqueued: number
  readonly targetIds: readonly string[]
}

export interface NcSimulateResult {
  readonly recordId: string
  readonly origin: 'synthetic'
  readonly delivery: string
  readonly candidates: number
  readonly outcomes: readonly NcSimulateOutcome[]
  readonly still: NcSimulateStillVerdict
  readonly notes: readonly string[]
  readonly droppedBy?: string
}

const COOLDOWNS: readonly NcSimulateCooldown[] = ['n/a', 'clear', 'suppressed', 'bypassed']
const STILL_VERDICTS: readonly NcSimulateStillVerdict[] = [
  'live',
  'none',
  'unavailable',
  'unattachable',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function parseOutcome(value: unknown): NcSimulateOutcome | null {
  if (!isRecord(value)) return null
  const ruleId = readString(value, 'ruleId')
  const ruleName = readString(value, 'ruleName')
  const cooldownRaw = readString(value, 'cooldown')
  const cooldown = COOLDOWNS.find((c) => c === cooldownRaw)
  if (ruleId === undefined || ruleName === undefined || cooldown === undefined) return null
  if (typeof value.matched !== 'boolean') return null
  const failedCondition = readString(value, 'failedCondition')
  const matchedOn = Array.isArray(value.matchedOn) ? readStringArray(value, 'matchedOn') : undefined
  return {
    ruleId,
    ruleName,
    matched: value.matched,
    ...(failedCondition !== undefined ? { failedCondition } : {}),
    ...(matchedOn !== undefined ? { matchedOn } : {}),
    cooldown,
    enqueued: typeof value.enqueued === 'number' ? value.enqueued : 0,
    targetIds: readStringArray(value, 'targetIds'),
  }
}

/**
 * Narrow the `addons.custom` answer (typed `unknown` end to end) to the result
 * shape, or return `null`.
 *
 * `null` is rendered as "this build could not read the hub's answer" — the
 * honest reading of a hub that predates the tester, or of a payload that has
 * since changed shape. Rendering an empty panel instead would look like "no
 * rule matched", which is a completely different fact.
 */
export function parseSimulateResult(value: unknown): NcSimulateResult | null {
  if (!isRecord(value)) return null
  const recordId = readString(value, 'recordId')
  const delivery = readString(value, 'delivery')
  const stillRaw = readString(value, 'still')
  const still = STILL_VERDICTS.find((s) => s === stillRaw)
  if (recordId === undefined || delivery === undefined || still === undefined) return null
  if (value.origin !== 'synthetic') return null
  const outcomesRaw = Array.isArray(value.outcomes) ? value.outcomes : []
  const outcomes: NcSimulateOutcome[] = []
  for (const entry of outcomesRaw) {
    const outcome = parseOutcome(entry)
    if (outcome !== null) outcomes.push(outcome)
  }
  const droppedBy = readString(value, 'droppedBy')
  return {
    recordId,
    origin: 'synthetic',
    delivery,
    candidates: typeof value.candidates === 'number' ? value.candidates : 0,
    outcomes,
    still,
    notes: readStringArray(value, 'notes'),
    ...(droppedBy !== undefined ? { droppedBy } : {}),
  }
}

/**
 * The headline sentence for a result — the thing the panel says FIRST.
 *
 * A run where nothing matched must read as an answer, never as an empty box:
 * the commonest cause is a rule set that declares a different delivery, and
 * `candidates === 0` is exactly that fact.
 */
export function summariseSimulateResult(result: NcSimulateResult): string {
  if (result.droppedBy !== undefined) {
    return i18n.t('helpers.notificationSimulateHelpers.dropped', { reason: result.droppedBy })
  }
  if (result.candidates === 0) {
    return i18n.t('helpers.notificationSimulateHelpers.noCandidates', { delivery: result.delivery })
  }
  const matched = result.outcomes.filter((o) => o.matched).length
  const enqueued = result.outcomes.reduce((sum, o) => sum + o.enqueued, 0)
  if (matched === 0) {
    return i18n.t('helpers.notificationSimulateHelpers.noneMatched', { count: result.candidates })
  }
  return i18n.t('helpers.notificationSimulateHelpers.matchedSummary', {
    matched,
    candidates: result.candidates,
    enqueued,
  })
}
