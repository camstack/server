/**
 * The Notification Rules editor's FORM STATE: its shape, hydration from a
 * stored rule, and what makes it saveable — split out of
 * `notification-rules.helpers.ts` (review M7). Pure.
 */

import type {
  NcConditionDescriptor,
  NcConditions,
  NcConfirmExpect,
  NcDelivery,
  NcMediaImage,
  NcMediaPolicy,
  NcRule,
  NcRuleAction,
  NcSharedSequence,
  NcRuleSectionSubject,
  NcSchedule,
  NcSystemEventDelivery,
  NcSystemEventFamily,
  NcThrottle,
  NcThrottleGranularity,
} from '@camstack/types'
import {
  audioIsFailClosed,
  conditionVisibleForKind,
  isSystemDelivery,
  NC_GROUPING_DEFAULT_SEC,
  NC_GROUPING_MAX_SEC,
  NC_GROUPING_MIN_SEC,
  resolveNcMediaImage,
  ruleGroupingApplies,
  ruleKindOf,
  describeSystemEventDeliveryProblem,
  scheduleForSendTimes,
  sendTimesForEditor,
  sendTimesOfSchedule,
  systemEventDeliveryProblems,
  templateCarriesSummary,
  systemRuleKindOf,
} from '@camstack/types'
import { seedSystemEventForFamily } from './notification-system-events'
import { projectRuleScope, type RuleScopeDraft, ruleScopeDraftOf } from './rule-scope-model'
import {
  actionsToForm,
  EMPTY_RULE_ACTIONS,
  formToActions,
  type NcRuleActionsFormState,
  validateRuleActions,
} from './notification-rule-actions'
import {
  isRecognisedDelivery,
  type NcDeliveryChoice,
  NC_COOLDOWN_MAX_SEC,
  NC_DEFAULT_COOLDOWN_SEC,
} from './rule-form-parsers'
import i18n from '../../i18n/index'

/**
 * Per-target passthrough params, keyed by `targetId`. D2 does not add a params
 * EDITOR, but it must not DROP params authored elsewhere — so the form carries
 * them verbatim across an edit (review L2).
 */
export type NcTargetParamsMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * The editable form state for a rule. D1 fields plus the D2 condition surface
 * (`conditions` + `schedule`) and the preserved per-target `params`. `throttle`
 * is not authored in the UI yet, so it stays out of the form and is preserved
 * through {@link buildRuleInput}.
 */
export interface NcRuleFormState {
  readonly name: string
  readonly enabled: boolean
  readonly delivery: NcDelivery
  readonly targetIds: readonly string[]
  /** USER ids to fan out to — resolved to each user's own targets at fire time. */
  readonly targetUsers: readonly string[]
  /** Preserved per-target passthrough params (L2) — carried, never authored in D2. */
  readonly targetParams: NcTargetParamsMap
  readonly priority: number
  /** The notification's picture (D897) — one mode, rendered from the clean frame. */
  readonly mediaImage: NcMediaImage
  /** Draw the zone that fired the rule on a scene picture (zone rules only). */
  readonly mediaShowTriggerZone: boolean
  /** Draw the subject's path on the picture (D903) — a kind with a tracked subject. */
  readonly mediaShowSubjectPath: boolean
  /** Also attach a GIF cut from the broker's clip ring around the event. */
  readonly mediaGif: boolean
  /** Also attach an MP4 clip of the same cut. */
  readonly mediaClip: boolean
  /** Stream profile for the gif/clip; undefined = the cheapest assigned. */
  readonly mediaProfile: NcMediaPolicy['profile']
  /** Playback rate of the gif/clip; undefined = the 2x default. */
  readonly mediaClipSpeed: NcMediaPolicy['clipSpeed']
  /**
   * Sensor rules only (ADR 0632): a mosaic of every linked camera, or one
   * image per camera. undefined = absent = the hub's default, a mosaic.
   */
  readonly mediaLinkedCameras: NcMediaPolicy['linkedCameras']
  readonly templateTitle: string
  readonly templateBody: string
  /**
   * Authored conditions (all-optional); empties are pruned at build time.
   * Never carries the four SCOPE lists (`devices`, `devicesExclude`,
   * `classes`, `classesExclude`) — those live in {@link deviceScope} and
   * {@link classScope} and are projected back in at save (D641).
   */
  readonly conditions: NcConditions
  /**
   * The detection-class scope (D641): "All | Only these | All except these"
   * over `classes` / `classesExclude`. The mode is derived when the rule is
   * opened and held here, because a mode switch keeps both lists until save.
   */
  readonly classScope: RuleScopeDraft<string>
  /** Weekly schedule windows (rule-level, `schedule` catalog group). */
  readonly schedule: NcSchedule | undefined
  /**
   * A device-events / system rule's DELIVERY (D647): absent or `instant` is a
   * notification per event; `summary` is one state summary at the end of each
   * window of its schedule. Carried as loaded, and sent only when set — so
   * switching back to Instant sends `{ mode: 'instant' }`, which is what
   * overwrites a stored summary through the hub's patch merge.
   */
  readonly systemEventDelivery: NcSystemEventDelivery | undefined
  /**
   * Whether a non-admin may snooze this rule for EVERYONE.
   *
   * A snooze is personal by default — it silences the person who set it. This
   * is the "the gardener is here all afternoon" opt-in, and it is off unless a
   * rule deliberately grants it, because it silences other people.
   */
  readonly snoozeAllowGlobal: boolean
  /**
   * The grouped window of an "Immediate, grouped" rule, in seconds (D692).
   *
   * `undefined` is plain Immediate. Meaningful only while the rule is an
   * `immediate` DETECTION rule ({@link ruleGroupingApplies}); the save drops it
   * (and `clear` removes a stored one) everywhere else, so a value left behind
   * by a trigger the operator moved away from is never sent. Held even when
   * out of range, so the box can be typed through; {@link ruleFormProblems}
   * blocks the save.
   */
  readonly groupingSec: number | undefined
  /**
   * The snooze durations this rule's notification offers as buttons, in
   * minutes.
   *
   * `undefined` and `[]` are DIFFERENT and both are authored here: absent means
   * the rule never said (the hub applies {@link NC_DEFAULT_SNOOZE_MINUTES}),
   * and an empty list means "no snooze buttons on this rule". The form holds
   * the concrete list and a flag for which of the two the operator chose,
   * because a single array cannot express the difference.
   */
  readonly snoozeOptions: readonly number[] | undefined
  /**
   * "Ask me to confirm detections" (#243). `undefined` = the operator has not
   * touched it; an explicit `false` is sent so a rule that had it can be
   * switched off (a patch merge would otherwise keep the stored `true`).
   */
  readonly askVerdict: boolean | undefined
  /**
   * What the rule ACTUATES, and the buttons its notification carries.
   *
   * Authored as one block because a button references a sequence by name — two
   * tabs owning the halves separately would let a button point at a sequence
   * the other tab had just renamed.
   */
  readonly actions: NcRuleActionsFormState
  /**
   * The device scope (D641): "All | Only these | All except these" over
   * `conditions.devices` / `conditions.devicesExclude`.
   *
   * Lifted out of `conditions` so the Devices tab can own it: `NC_RULE_TABS` is
   * guarded on every form field being claimed by exactly ONE tab, and leaving
   * it inside `conditions` would have forced two tabs to claim that object.
   * Projected back into `conditions` in {@link buildRuleInput} — the same shape
   * `schedule` already has.
   */
  readonly deviceScope: RuleScopeDraft<number>
  /**
   * Minimum gap between two deliveries of this rule (`throttle.cooldownSec`).
   *
   * Separate from {@link cooldownScope} / {@link cooldownGranularity} — the
   * three are not one control: those change what the cooldown COUNTS, and an
   * operator asking "stop repeating this" is asking about the interval.
   */
  readonly cooldownSec: number
  /**
   * WHAT the cooldown is counted per (`throttle.scope`, D654): `rule-device`
   * — one window per camera — or `rule` — one window for the whole rule.
   * Always written: the schema defaults it, so every stored rule carries one.
   */
  readonly cooldownScope: NcThrottle['scope']
  /**
   * Class granularity of the window (`throttle.granularity`, D654): `shared`
   * (a cat silences the next dog) or `per-class`. `undefined` = the rule never
   * chose, which the engine reads as `shared` — and which is NOT written, so
   * an unset rule stays unset through an admin save.
   */
  readonly cooldownGranularity: NcThrottleGranularity | undefined
}

/**
 * The snooze durations a notification offers when the rule does not say, and
 * the full palette the editor lets an operator pick from.
 *
 * MIRRORS `NC_DEFAULT_SNOOZE_MINUTES` in `@camstack/types`, and mirrored for
 * the same reason as {@link isRuleSnoozeExempt}: that package reaches this
 * addon as a Module-Federation SINGLETON provided by the HOST, so importing a
 * newly-added export would read `undefined` until a server closure carrying it
 * is installed — and this editor is deployed long before that.
 *
 * The palette is a superset, not a second policy: the hub bounds the list
 * (`.max(4)`, 1..NC_SNOOZE_MAX_MINUTES) and this only decides what is offered.
 */
export const NC_DEFAULT_SNOOZE_MINUTES: readonly number[] = [10, 30, 60]

export const NC_SNOOZE_BUTTON_CHOICES: readonly number[] = [5, 10, 15, 30, 60, 120, 240, 480]

/** `30 min` / `2 h` — whole hours read as hours, because nobody should do that
 *  arithmetic on a lock screen or in a picker. */
export function snoozeChoiceLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0)
    return i18n.t('helpers.ruleFormState.snoozeHours', { count: minutes / 60 })
  return i18n.t('helpers.ruleFormState.snoozeMin', { count: minutes })
}

/**
 * The panel's transitions (every kind in the hub's
 * `NC_ALARM_SYSTEM_EVENT_KINDS` — the spec pins the parity), and the cap that
 * moves it.
 *
 * A LOCAL copy of what `addon-post-analysis/notification-center/snooze-exempt.ts`
 * decides, and the duplication is deliberate rather than lazy: `@camstack/types`
 * reaches this addon as a Module-Federation SINGLETON provided by the HOST, so a
 * shared helper added to it is `undefined` here until a server closure carrying
 * it is installed. The admin would then render "snooze available" on an alarm
 * rule the hub refuses to snooze — a badge that lies is worse than none.
 *
 * Both lists are closed and change only with the panel itself; the addon module
 * remains the authority, and this exists to SHOW its answer.
 */
const NC_ALARM_KINDS: ReadonlySet<string> = new Set([
  'alarm-arm-refused',
  'alarm-check-failed',
  'alarm-arming',
  'alarm-armed',
  'alarm-pending',
  'alarm-triggered',
  'alarm-rearmed',
  'alarm-sensor-bypass',
  'alarm-disarmed',
])
const NC_ALARM_PANEL_CAP = 'alarm-panel'

/**
 * Is this rule one a snooze can never silence?
 *
 * True when the rule is ABOUT the panel (a system-event kind) or ACTUATES it
 * (a Do / shared-sequence step on the `alarm-panel` cap). Derived from what
 * the operator already wrote — nothing is stored, so the editor cannot
 * disagree with the engine.
 */
export function isRuleSnoozeExempt(
  conditions: NcConditions,
  steps: readonly NcRuleAction[],
): boolean {
  for (const kind of conditions.systemEvent?.kinds ?? []) {
    if (NC_ALARM_KINDS.has(kind)) return true
  }
  for (const step of steps) {
    if (step.kind === 'cap' && step.cap === NC_ALARM_PANEL_CAP) return true
  }
  return false
}

/** Resolve form bindings against the shared sequence list for snooze exemption. */
export function formStepsForSnooze(
  form: NcRuleActionsFormState,
  sequences: readonly NcSharedSequence[],
): readonly NcRuleAction[] {
  const byId = new Map(sequences.map((s) => [s.id, s]))
  const out: NcRuleAction[] = []
  for (const key of ['onActivation', 'onDeactivation', 'onTrigger', 'onTriggerOff'] as const) {
    for (const binding of form[key]) {
      if (binding.kind === 'do') out.push(binding.action)
      else {
        const seq = byId.get(binding.sequenceId)
        if (seq !== undefined) out.push(...seq.actions)
      }
    }
  }
  for (const button of form.buttons) {
    const seq = byId.get(button.sequenceId)
    if (seq !== undefined) out.push(...seq.actions)
  }
  return out
}

/** The form's slice of a rule's conditions: everything, and the two scope axes. */
export interface NcRuleScopeSplit {
  readonly conditions: NcConditions
  readonly deviceScope: RuleScopeDraft<number>
  readonly classScope: RuleScopeDraft<string>
}

/**
 * Lift the two scope axes out of stored conditions (D641). The mode of each is
 * DERIVED from its two lists (`rule-scope-model.ts`); nothing about a mode is
 * stored on the rule.
 */
export function splitRuleScopes(conditions: NcConditions): NcRuleScopeSplit {
  const { devices, devicesExclude, classes, classesExclude, ...rest } = conditions
  return {
    conditions: rest,
    deviceScope: ruleScopeDraftOf(devices, devicesExclude),
    classScope: ruleScopeDraftOf(classes, classesExclude),
  }
}

/**
 * The conditions the form MEANS: the authored conditions with each scope axis
 * projected back as its save writes it — the active mode's list only (plus a
 * legacy rule's kept exclusions). What {@link buildRuleInput} prunes and what
 * {@link droppedConditions} judges, so the two cannot disagree.
 */
export function formScopedConditions(
  form: Pick<NcRuleFormState, 'conditions' | 'deviceScope' | 'classScope'>,
): NcConditions {
  const devices = projectRuleScope(form.deviceScope)
  const classes = projectRuleScope(form.classScope)
  return {
    ...form.conditions,
    ...(devices.include !== undefined ? { devices: [...devices.include] } : {}),
    ...(devices.exclude !== undefined ? { devicesExclude: [...devices.exclude] } : {}),
    ...(classes.include !== undefined ? { classes: [...classes.include] } : {}),
    ...(classes.exclude !== undefined ? { classesExclude: [...classes.exclude] } : {}),
  }
}

/** The devices a zone / event-kind picker resolves from: an Only scope's list, else none (= all). */
export function formScopedDeviceIds(form: Pick<NcRuleFormState, 'deviceScope'>): readonly number[] {
  return form.deviceScope.mode === 'only' ? form.deviceScope.include : []
}

/** The two exclusion conditions a scope pre-selector can offer (D641). */
export type NcScopeExcludeConditionId = 'devicesExclude' | 'classesExclude'

/**
 * Is "All except these" offered for this axis? Only when the hub SERVES the
 * exclusion for this rule's trigger and kind: a hub that does not know the key
 * strips it on save, and the rule would silently include what the operator
 * excluded.
 */
export function ruleScopeExceptOffered(
  catalog: readonly NcConditionDescriptor[],
  id: NcScopeExcludeConditionId,
  form: NcRuleSectionSubject,
): boolean {
  const kind = ruleKindOf(form)
  return catalog.some((d) => d.id === id && conditionVisibleForKind(d, form.delivery, kind))
}

/**
 * A blank form for the "New rule" flow.
 *
 * `conditions` is the section PRESET (see {@link ruleSeedForSection}) and
 * defaults to none. It seeds only the condition that DEFINES the kind of rule —
 * never a filter the operator did not ask for, which would be a restriction
 * they cannot see they are shipping.
 */
export function emptyRuleForm(
  delivery: NcDelivery = 'immediate',
  conditions: NcConditions = {},
): NcRuleFormState {
  return {
    name: '',
    enabled: true,
    delivery,
    targetIds: [],
    targetUsers: [],
    targetParams: {},
    priority: 3,
    // The kind's own default picture: a subject crop for a detection, the
    // clean scene for a sensor or a sound (`resolveNcMediaImage`).
    mediaImage: resolveNcMediaImage({}, ruleKindOf({ delivery, conditions })),
    mediaShowTriggerZone: false,
    mediaShowSubjectPath: false,
    mediaGif: false,
    mediaClip: false,
    mediaProfile: undefined,
    mediaClipSpeed: undefined,
    mediaLinkedCameras: undefined,
    templateTitle: '',
    templateBody: '',
    ...splitRuleScopes(conditions),
    schedule: undefined,
    systemEventDelivery: undefined,
    // Default OFF: silencing a rule for everyone must be deliberate.
    snoozeAllowGlobal: false,
    // Plain Immediate: grouping is a deliberate choice on the trigger.
    groupingSec: undefined,
    // Absent, not `[]`: a new rule has not said anything about its snooze
    // buttons, and the hub's defaults are the right answer for one.
    snoozeOptions: undefined,
    askVerdict: undefined,
    actions: EMPTY_RULE_ACTIONS,
    cooldownSec: NC_DEFAULT_COOLDOWN_SEC,
    // The store's own defaults (`NcThrottleSchema`): per camera, one window
    // across classes.
    cooldownScope: 'rule-device',
    cooldownGranularity: undefined,
  }
}

/** Hydrate the form from an existing persisted rule (the "Edit" / duplicate flow). */
export function ruleToForm(rule: NcRule): NcRuleFormState {
  const targetParams: Record<string, Readonly<Record<string, unknown>>> = {}
  for (const t of rule.targets) {
    if (t.params && Object.keys(t.params).length > 0) targetParams[t.targetId] = t.params
  }
  return {
    name: rule.name,
    enabled: rule.enabled,
    delivery: rule.delivery,
    targetIds: rule.targets.map((t) => t.targetId),
    targetUsers: rule.targetUsers ?? [],
    targetParams,
    priority: rule.priority,
    // A rule the hub has not re-saved since D897 still reads right: the same
    // mapping the hub's migration applies.
    mediaImage: resolveNcMediaImage(rule.media, ruleKindOf(rule)),
    mediaShowTriggerZone: rule.media.showTriggerZone === true,
    mediaShowSubjectPath: rule.media.showSubjectPath === true,
    mediaGif: rule.media.gif === true,
    mediaClip: rule.media.clip === true,
    mediaProfile: rule.media.profile,
    mediaClipSpeed: rule.media.clipSpeed,
    mediaLinkedCameras: rule.media.linkedCameras,
    templateTitle: rule.template?.title ?? '',
    templateBody: rule.template?.body ?? '',
    ...splitRuleScopes(rule.conditions),
    schedule: rule.schedule,
    systemEventDelivery: rule.systemEventDelivery,
    snoozeAllowGlobal: rule.snoozeAllowGlobal === true,
    groupingSec: rule.groupingSec,
    // Carried verbatim, INCLUDING an empty list: `[]` is the operator saying
    // "no snooze buttons", and reading it back as absent would silently
    // restore the defaults on the next save.
    snoozeOptions: rule.snoozeOptions,
    askVerdict: rule.askVerdict,
    actions: actionsToForm(rule.actions),
    cooldownSec: rule.throttle.cooldownSec,
    cooldownScope: rule.throttle.scope,
    cooldownGranularity: rule.throttle.granularity,
  }
}

/**
 * What this form would ship that can NEVER fire — in the operator's words.
 *
 * Blockers, not warnings: every entry describes a rule the store would accept
 * and the engine would then refuse, which is the worst failure this page has —
 * a rule that looks authored, sits in the list enabled, and notifies nobody
 * ever. Returned as prose so the dialog can SAY why Save is disabled; a
 * disabled button with no reason is how an operator concludes the page is
 * broken.
 */
export function ruleFormProblems(
  form: NcRuleFormState,
  preserved?: Pick<NcRule, 'confirm'>,
): readonly string[] {
  const problems: string[] = []
  // "Immediate, grouped" (D692): the hub's own bounds, and its T16 refusal of a
  // grouped rule whose AI confirm expects more than one subject — a tile shows
  // ONE. `confirm` is not authored here (it rides in `preserved`), so the
  // operator is told which way out there is instead of meeting the refusal as
  // a failed save.
  if (groupingIsSent(form)) {
    const seconds = form.groupingSec
    if (
      seconds !== undefined &&
      (!Number.isInteger(seconds) || seconds < NC_GROUPING_MIN_SEC || seconds > NC_GROUPING_MAX_SEC)
    ) {
      problems.push(
        `The grouping window is a whole number of seconds between ${String(NC_GROUPING_MIN_SEC)} and ${String(NC_GROUPING_MAX_SEC)}.`,
      )
    }
    const confirm = preserved?.confirm
    if (
      confirm?.enabled === true &&
      confirm.expect !== undefined &&
      !expectationMetByOneSubject(confirm.expect)
    ) {
      problems.push(
        'This rule’s AI confirm expects more than one subject, but a grouped message judges one picture per subject, so it would never send. Remove the confirm expectation (viewer or API), or choose Immediate.',
      )
    }
  }
  // The engine's own gate, mirrored: `matchesAudio` returns false when the
  // condition names neither a level floor nor a label, because every sample
  // would be a hit and the window would fire on silence.
  if (audioIsFailClosed(form.conditions.audio)) {
    problems.push(
      'This sound rule names neither a sound nor a level threshold, so it can never fire — every sample would count as a hit and the engine refuses it rather than notifying on silence. Pick at least one sound, or add a level.',
    )
  }
  // The bound the removed `<Select>` used to provide for free. An input has no
  // option list, so the hub's own `int().min(0).max(86_400)` is stated here —
  // the operator gets a sentence and a disabled Save instead of a Zod string
  // from the server after the save round-trip.
  if (
    !Number.isInteger(form.cooldownSec) ||
    form.cooldownSec < 0 ||
    form.cooldownSec > NC_COOLDOWN_MAX_SEC
  ) {
    problems.push(
      `The cooldown is a whole number of seconds between 0 and ${String(NC_COOLDOWN_MAX_SEC)} (24 hours). 0 means every match is delivered.`,
    )
  }
  // The hub's own D647 verdict on the delivery — the schedule is left out on
  // purpose: `buildRuleInput` drops it from a summary rule.
  if (isStateSummaryForm(form)) {
    for (const problem of systemEventDeliveryProblems({
      delivery: form.delivery,
      conditions: form.conditions,
      ...(form.systemEventDelivery !== undefined
        ? { systemEventDelivery: form.systemEventDelivery }
        : {}),
      ...(formToActions(form.actions) !== undefined
        ? { actions: formToActions(form.actions) }
        : {}),
    })) {
      problems.push(describeSystemEventDeliveryProblem(problem))
    }
  }
  return problems
}

/**
 * The delivery a save sends (D647). A system rule sends what the form holds.
 * A rule moved to ANOTHER trigger that still carries a summary sends
 * `{ mode: 'instant' }` — otherwise the stored summary survives the hub's
 * merge and the save is refused as `not-a-system-rule` (review M4).
 */
export function systemEventDeliveryForSave(form: NcRuleFormState): {
  readonly systemEventDelivery?: NcSystemEventDelivery
} {
  const delivery = form.systemEventDelivery
  if (delivery === undefined) return {}
  if (!isSystemDelivery(form.delivery)) {
    return delivery.mode === 'summary' ? { systemEventDelivery: { mode: 'instant' } } : {}
  }
  // Punctual wire shape: rewrite legacy range bands (e.g. 17:00→18:00) to
  // one-minute windows at each END so the next open shows one clock, not two.
  if (delivery.mode === 'summary' && sendTimesOfSchedule(delivery.schedule) === null) {
    const parsed = sendTimesForEditor(delivery.schedule)
    if (parsed !== null && parsed.times.length > 0) {
      return {
        systemEventDelivery: {
          ...delivery,
          schedule: scheduleForSendTimes(parsed.times, delivery.schedule.timezone),
        },
      }
    }
  }
  return { systemEventDelivery: delivery }
}

/**
 * The warning a summary rule's custom body earns when it names none of the
 * summary's content: the hub appends `{{summaryText}}` to it (review M3).
 */
export function summaryTemplateWarning(form: NcRuleFormState): string | null {
  if (!isStateSummaryForm(form)) return null
  if (!templateCarriesSummary(form.templateBody)) {
    return i18n.t('helpers.ruleFormState.summaryWarnNone', { token: '{{summaryText}}' })
  }
  // Split per category (D698 review M3): a body that names one section's
  // variable but not {{summaryText}} would be empty on every OTHER category's
  // notification, so the hub completes those.
  const body = form.templateBody
  const split =
    form.systemEventDelivery?.mode === 'summary' ? form.systemEventDelivery.split : undefined
  if (split === 'section' && body.trim().length > 0 && !/\{\{\s*summaryText\s*\}\}/.test(body)) {
    return i18n.t('helpers.ruleFormState.summaryWarnSplit', { token: '{{summaryText}}' })
  }
  return null
}

/** Is this form a scheduled STATE SUMMARY (D647)? */
export function isStateSummaryForm(form: NcRuleFormState): boolean {
  return isSystemDelivery(form.delivery) && form.systemEventDelivery?.mode === 'summary'
}

/** True when the form can be saved (name present, at least one target OR user). */
export function isRuleFormValid(
  form: NcRuleFormState,
  preserved?: Pick<NcRule, 'confirm'>,
  knownSequenceIds: ReadonlySet<string> = new Set(),
): boolean {
  return (
    // A condition the engine would refuse blocks the save. The rule would be
    // stored, enabled and permanently silent otherwise.
    ruleFormProblems(form, preserved).length === 0 &&
    // A trigger with no option in this build is not saveable, EVER. The type
    // says `NcDelivery`, and that is exactly how the last failure got in: the
    // enum grew a member (`system-event`) that the option list did not, so a
    // well-typed form still carried a value the editor could not render. The
    // dialog refuses to open an editor for it; this refuses to write one.
    isRecognisedDelivery(form.delivery) &&
    // A system rule with no event selected is rejected by the hub
    // (`kinds.min(1)`). The editor never gets there — the last kind cannot be
    // unticked — so this is the backstop, not the operator's message.
    (!isSystemDelivery(form.delivery) || systemEventKindCount(form) > 0) &&
    // Nor is a `mixed` one (kinds across families, a legacy kind): the hub
    // refuses it on create (D637), so the UI refuses it too, by construction.
    ruleKindOf(form) !== 'mixed' &&
    form.name.trim().length > 0 &&
    (form.targetIds.length > 0 || form.targetUsers.length > 0) &&
    // The actions problems BLOCK the save rather than merely being displayed.
    // A button / binding pointing at a missing sequence would be accepted by
    // the store and then do nothing. Shown-but-saveable is how a warning
    // becomes decoration.
    validateRuleActions(form.actions, knownSequenceIds).length === 0
  )
}

/**
 * The form with its trigger changed.
 *
 * Switching TO `system-event` on a rule that names no event kind seeds the
 * device-events family (D637): a system rule with no kinds classifies `mixed`,
 * which is read-only and never authored. The operator changes the family with
 * {@link changeSystemEventFamily}. Kinds the rule already names are kept.
 */
export function changeRuleDelivery(form: NcRuleFormState, delivery: NcDelivery): NcRuleFormState {
  const conditions = withoutPipelineSourceOff(form.conditions, delivery)
  const needsSeed = isSystemDelivery(delivery) && (conditions.systemEvent?.kinds.length ?? 0) === 0
  if (!needsSeed) return { ...form, delivery, conditions }
  return {
    ...form,
    delivery,
    conditions: { ...conditions, systemEvent: seedSystemEventForFamily('device-events') },
  }
}

/**
 * The form with its trigger CHOICE changed (D692 §10).
 *
 * `immediate-grouped` is a UI-only value: `delivery: 'immediate'` plus a
 * `groupingSec`, kept if the operator already chose one, else
 * {@link NC_GROUPING_DEFAULT_SEC}. Every other choice is a plain delivery,
 * routed through {@link changeRuleDelivery}, and forgets the window — the hub
 * refuses `groupingSec` on a rule that cannot group.
 */
export function applyDeliveryChoice(
  prev: NcRuleFormState,
  choice: NcDeliveryChoice,
): NcRuleFormState {
  if (choice === 'immediate-grouped') {
    return {
      ...changeRuleDelivery(prev, 'immediate'),
      groupingSec: prev.groupingSec ?? NC_GROUPING_DEFAULT_SEC,
    }
  }
  return { ...changeRuleDelivery(prev, choice), groupingSec: undefined }
}

/**
 * Does THIS form send a `groupingSec`? Only an `immediate` detection rule that
 * holds one. The single place the save, the problems and the choice read, so the
 * three cannot disagree about which rules are grouped.
 */
/**
 * Can this rule ask for a verdict? Only a rule that reports a TRACK: an
 * immediate or a track-end detection rule. A sensor or system rule has no
 * track to mark, and a flag left on the form by a trigger the operator moved
 * away from must not reach the hub.
 */
export function verdictApplies(form: Pick<NcRuleFormState, 'delivery'>): boolean {
  return form.delivery === 'immediate' || form.delivery === 'track-end'
}

export function groupingIsSent(
  form: Pick<NcRuleFormState, 'delivery' | 'conditions' | 'groupingSec'>,
): boolean {
  return form.groupingSec !== undefined && ruleGroupingApplies(form)
}

/**
 * Is an AI-confirm expectation met by a count of ONE subject? A mirror of the
 * engine's `satisfies(1, expect)` (`confirm-gate.ts`), which the admin bundle
 * cannot import. `>=` is the default arm there too: an unknown comparison reads
 * as "at least", the one reading that cannot silence a camera.
 */
function expectationMetByOneSubject(expect: NcConfirmExpect): boolean {
  switch (expect.op) {
    case '>':
      return 1 > expect.count
    case '<=':
      return 1 <= expect.count
    case '<':
      return 1 < expect.count
    case '==':
      return 1 === expect.count
    default:
      return 1 >= expect.count
  }
}

/** The triggers whose subject is a pipeline DETECTION — where `source: 'pipeline'` narrows. */
const PIPELINE_SOURCE_DELIVERIES: ReadonlySet<NcDelivery> = new Set([
  'immediate',
  'track-end',
  'package-event',
])

/**
 * The `pipeline` source a new detection rule is seeded with (R5, D690) does not
 * follow the rule onto another trigger: a sensor event is stamped `sensor`, so
 * it would silence the rule for good. Any other source is the operator's.
 */
function withoutPipelineSourceOff(conditions: NcConditions, delivery: NcDelivery): NcConditions {
  if (conditions.source !== 'pipeline' || PIPELINE_SOURCE_DELIVERIES.has(delivery))
    return conditions
  const { source: _source, ...rest } = conditions
  return rest
}

/**
 * The form re-seeded for another system family: its kinds become the family's
 * seed, and every filter goes with the old kinds. Picking the family the rule
 * already is returns the form unchanged.
 */
export function changeSystemEventFamily(
  form: NcRuleFormState,
  family: NcSystemEventFamily,
): NcRuleFormState {
  if (systemRuleKindOf(form.conditions.systemEvent) === family) return form
  return {
    ...form,
    conditions: { ...form.conditions, systemEvent: seedSystemEventForFamily(family) },
  }
}

/** How many system-event kinds the form has selected (0 when absent). */
export function systemEventKindCount(form: NcRuleFormState): number {
  return form.conditions.systemEvent?.kinds.length ?? 0
}
