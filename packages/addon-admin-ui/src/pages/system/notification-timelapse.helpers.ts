/**
 * The Timelapse tab's contract with the `nc.*TimelapseRule*` bridge, and the
 * pure form model behind the editor.
 *
 * ## Narrowed by the REAL schema, unlike the Summaries tab
 *
 * `addons.custom` is typed `z.unknown()` at the cap boundary here too, so the
 * answer still has to be narrowed. But a timelapse rule's schema lives in
 * `@camstack/types` (`notification/timelapse-rule.ts`), so the narrowing can be
 * the schema ITSELF rather than a hand-written mirror of it — one authority for
 * what a rule is, and no way for this file to disagree with the store about a
 * bound. The summary rule cannot do this: its schema is addon-local by design.
 *
 * A consequence worth naming: Zod STRIPS unknown keys, so a field a newer hub
 * grew is not visible here. That is safe only because the patch below is a
 * DIFF — a key this build cannot see is a key it never sends, and the upsert
 * merges what it is sent over the stored rule, so the invisible field survives.
 *
 * ## `denseCadenceSec` ABSENT IS A VALUE
 *
 * Absent means "derive it": `max(1s, cadenceSec / 30)`, resolved at render time
 * from whatever the base cadence is THEN. Both rules live on this hub today are
 * absent. An editor that displayed the derived number in an ordinary box and
 * saved it back would pin today's derivation into the rule, and the next change
 * to the base cadence would silently stop moving it. So the form keeps
 * `undefined` distinct from a number, and "Automatic" is a real choice.
 *
 * The wire has no clear signal for the field (the patch schema is not
 * nullable), so switching a pinned rule BACK to automatic writes the derivation
 * explicitly — visibly, with the number in the patch, never by pretending the
 * key was removed.
 *
 * ## `previewText` has THREE states
 *
 * Absent → the shipped caption (`Timelapse {{camera}}`). `''` → no caption at
 * all, deliberately reachable. A string → that caption. A form with one text
 * box cannot express the first two, which is why `previewTextSet` exists.
 */

import type { NcRuleTarget, NcSchedule } from '@camstack/types'
import {
  DEFAULT_TIMELAPSE_PREVIEW_TEXT,
  TIMELAPSE_DENSE_FLOOR_SEC,
  TimelapseRuleSchema,
} from '@camstack/types'
import { z } from 'zod'

import { agoLabel, sameShape, scheduleLabel, targetsFromIds } from './notification-digest.helpers'
import i18n from '../../i18n/index'

// ── The bridge ───────────────────────────────────────────────────────

export { NC_ADDON_ID } from './notification-texts.helpers'

export const NC_LIST_TIMELAPSE_RULES_ACTION = 'nc.listTimelapseRules'
export const NC_UPSERT_TIMELAPSE_RULE_ACTION = 'nc.upsertTimelapseRule'
export const NC_DELETE_TIMELAPSE_RULE_ACTION = 'nc.deleteTimelapseRule'
export const NC_TEST_TIMELAPSE_RULE_ACTION = 'nc.testTimelapseRule'

// ── Bounds, from the schema's own vocabulary ─────────────────────────

export const TIMELAPSE_CADENCE_MIN_SEC = 2
export const TIMELAPSE_CADENCE_MAX_SEC = 3600
export const TIMELAPSE_FRAMERATE_MIN = 1
export const TIMELAPSE_FRAMERATE_MAX = 60
export const TIMELAPSE_DENSE_MAX_SEC = 3600
export const TIMELAPSE_MIN_DWELL_MAX_SEC = 60
export const TIMELAPSE_PREVIEW_TEXT_MAX = 200
export const TIMELAPSE_REPORT_CLASSES_MAX = 20
export const TIMELAPSE_NAME_MAX = 200

/** The renderer's own derivation divisor and floor — not a second opinion. */
const DENSE_CADENCE_DIVISOR = 30
const DENSE_DERIVED_FLOOR_SEC = 1

export { DEFAULT_TIMELAPSE_PREVIEW_TEXT, TIMELAPSE_DENSE_FLOOR_SEC }

export const TIMELAPSE_PREVIEW_MODES = ['image', 'gif'] as const
export type TimelapsePreviewModeChoice = (typeof TIMELAPSE_PREVIEW_MODES)[number]

export const TIMELAPSE_PREVIEW_MODE_LABELS: Readonly<Record<TimelapsePreviewModeChoice, string>> = {
  image: 'Still frame',
  gif: 'Short animation (GIF)',
}

// ── The narrowed rule ────────────────────────────────────────────────

/**
 * What `nc.listTimelapseRules` answers: the persisted rule plus the server's
 * per-caller `readOnly` verdict. `.optional()` on `readOnly` because a hub that
 * predates the flag simply does not send it — and "not stated" must mean
 * editable, not "silently locked".
 */
const TimelapseRuleViewSchema = TimelapseRuleSchema.extend({
  readOnly: z.boolean().optional(),
})
export type TimelapseRuleView = z.infer<typeof TimelapseRuleViewSchema>

const TimelapseRuleListSchema = z.object({
  rules: z.array(TimelapseRuleViewSchema),
})

/**
 * Narrow the list answer. `null` on anything this bundle cannot read — the tab
 * then SAYS the hub answered something it does not understand, rather than
 * rendering an empty table, which reads as "my rules are gone".
 */
export function parseTimelapseRules(raw: unknown): readonly TimelapseRuleView[] | null {
  const parsed = TimelapseRuleListSchema.safeParse(raw)
  return parsed.success ? parsed.data.rules : null
}

export function isTimelapseRuleEditable(rule: TimelapseRuleView): boolean {
  return rule.readOnly !== true
}

const TimelapseTestOutcomeSchema = z.object({
  produced: z.number(),
  exportId: z.string().optional(),
  coveragePercent: z.number().optional(),
  enqueued: z.number().optional(),
  windowStartMs: z.number().optional(),
  windowEndMs: z.number().optional(),
  error: z.string().optional(),
})
export type TimelapseTestOutcome = z.infer<typeof TimelapseTestOutcomeSchema>

export function parseTimelapseTestOutcome(raw: unknown): TimelapseTestOutcome | null {
  const parsed = TimelapseTestOutcomeSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ── The form ─────────────────────────────────────────────────────────

export interface TimelapseFormState {
  readonly name: string
  readonly enabled: boolean
  readonly deviceIds: readonly number[]
  /** REQUIRED by the schema — `undefined` here is an unfinished form. */
  readonly schedule: NcSchedule | undefined
  readonly cadenceSec: number
  readonly framerate: number
  /** `undefined` = derive it from the base cadence. See the module docblock. */
  readonly denseCadenceSec: number | undefined
  readonly minDwellSec: number | undefined
  readonly targetIds: readonly string[]
  readonly templateTitle: string
  readonly templateBody: string
  /** Only meaningful when `previewTextSet` — `''` is "no caption". */
  readonly previewText: string
  readonly previewTextSet: boolean
  readonly previewMode: TimelapsePreviewModeChoice
  readonly reportClasses: readonly string[]
  readonly priority: number
}

/** The defaults a NEW timelapse opens on — the schema's own, verbatim. */
export function emptyTimelapseForm(): TimelapseFormState {
  return {
    name: '',
    enabled: true,
    deviceIds: [],
    schedule: undefined,
    cadenceSec: 15,
    framerate: 10,
    denseCadenceSec: undefined,
    minDwellSec: undefined,
    targetIds: [],
    templateTitle: '',
    templateBody: '',
    previewText: '',
    previewTextSet: false,
    previewMode: 'image',
    reportClasses: [],
    priority: 3,
  }
}

export function timelapseRuleToForm(rule: TimelapseRuleView): TimelapseFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    deviceIds: [...rule.deviceIds],
    schedule: rule.schedule,
    cadenceSec: rule.cadenceSec,
    framerate: rule.framerate,
    denseCadenceSec: rule.denseCadenceSec,
    minDwellSec: rule.minDwellSec,
    targetIds: rule.targets.map((t) => t.targetId),
    templateTitle: rule.template?.title ?? '',
    templateBody: rule.template?.body ?? '',
    previewText: rule.previewText ?? '',
    previewTextSet: rule.previewText !== undefined,
    previewMode: rule.previewMode,
    reportClasses: [...(rule.reportClasses ?? [])],
    priority: rule.priority,
  }
}

// ── What goes on the wire ────────────────────────────────────────────

export interface TimelapseRuleInputWire {
  readonly name: string
  readonly enabled: boolean
  readonly deviceIds: readonly number[]
  readonly schedule: NcSchedule
  readonly cadenceSec: number
  readonly framerate: number
  readonly denseCadenceSec?: number
  readonly minDwellSec?: number
  readonly targets: readonly NcRuleTarget[]
  readonly template?: TimelapseTemplateWire
  readonly previewText?: string
  readonly previewMode: TimelapsePreviewModeChoice
  readonly reportClasses?: readonly string[]
  readonly priority: number
}

export interface TimelapseTemplateWire {
  readonly title?: string
  readonly body?: string
}

/** `template` is the one clearable field: `null` removes it. */
export interface TimelapseRulePatchWire {
  readonly name?: string
  readonly enabled?: boolean
  readonly deviceIds?: readonly number[]
  readonly schedule?: NcSchedule
  readonly cadenceSec?: number
  readonly framerate?: number
  readonly denseCadenceSec?: number
  readonly minDwellSec?: number
  readonly targets?: readonly NcRuleTarget[]
  readonly template?: TimelapseTemplateWire | null
  readonly previewText?: string
  readonly previewMode?: TimelapsePreviewModeChoice
  readonly reportClasses?: readonly string[]
  readonly priority?: number
}

/**
 * An empty weekly schedule the form falls back on ONLY when it is being sent
 * for a rule the validation has already accepted — the problems list refuses a
 * form with no schedule, so this branch is unreachable on a saved rule and
 * exists to keep the builder total.
 */
const NO_SCHEDULE: NcSchedule = {
  windows: [{ days: [1], startMinute: 0, endMinute: 60 }],
}

function formTemplate(form: TimelapseFormState): TimelapseTemplateWire | undefined {
  const title = form.templateTitle.trim()
  const body = form.templateBody.trim()
  if (title.length === 0 && body.length === 0) return undefined
  return {
    ...(title.length > 0 ? { title } : {}),
    ...(body.length > 0 ? { body } : {}),
  }
}

export function buildTimelapseCreateInput(form: TimelapseFormState): TimelapseRuleInputWire {
  const template = formTemplate(form)
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    deviceIds: [...form.deviceIds],
    schedule: form.schedule ?? NO_SCHEDULE,
    cadenceSec: form.cadenceSec,
    framerate: form.framerate,
    ...(form.denseCadenceSec !== undefined ? { denseCadenceSec: form.denseCadenceSec } : {}),
    ...(form.minDwellSec !== undefined ? { minDwellSec: form.minDwellSec } : {}),
    targets: targetsFromIds(form.targetIds),
    ...(template !== undefined ? { template } : {}),
    // `''` is a real answer ("the frame, no caption"), so it is sent whenever
    // the operator has touched the field at all.
    ...(form.previewTextSet ? { previewText: form.previewText } : {}),
    previewMode: form.previewMode,
    ...(form.reportClasses.length > 0 ? { reportClasses: [...form.reportClasses] } : {}),
    priority: form.priority,
  }
}

/**
 * ONLY what the operator changed.
 *
 * The upsert merges the patch over the stored rule, so an omitted key is a
 * preserved key — which is what keeps `generatedByDevice`, `lastGeneratedAt`
 * and any field a newer hub grew intact through an edit made here.
 */
export function buildTimelapsePatch(
  form: TimelapseFormState,
  existing: TimelapseRuleView,
): TimelapseRulePatchWire {
  const next = buildTimelapseCreateInput(form)
  const patch: {
    name?: string
    enabled?: boolean
    deviceIds?: readonly number[]
    schedule?: NcSchedule
    cadenceSec?: number
    framerate?: number
    denseCadenceSec?: number
    minDwellSec?: number
    targets?: readonly NcRuleTarget[]
    template?: TimelapseTemplateWire | null
    previewText?: string
    previewMode?: TimelapsePreviewModeChoice
    reportClasses?: readonly string[]
    priority?: number
  } = {}

  if (next.name !== existing.name) patch.name = next.name
  if (next.enabled !== existing.enabled) patch.enabled = next.enabled
  if (!sameShape(next.deviceIds, existing.deviceIds)) patch.deviceIds = next.deviceIds
  if (!sameShape(next.schedule, existing.schedule)) patch.schedule = next.schedule
  if (next.cadenceSec !== existing.cadenceSec) patch.cadenceSec = next.cadenceSec
  if (next.framerate !== existing.framerate) patch.framerate = next.framerate
  if (next.denseCadenceSec !== existing.denseCadenceSec) {
    // Back to AUTOMATIC on a rule that had a pinned value: the wire cannot
    // express "remove this key", so the derivation is written explicitly and
    // the editor says so. Silently leaving the old pin would be a control that
    // does nothing.
    patch.denseCadenceSec = next.denseCadenceSec ?? derivedDenseCadenceSec(next.cadenceSec)
  }
  if (next.minDwellSec !== existing.minDwellSec && next.minDwellSec !== undefined) {
    patch.minDwellSec = next.minDwellSec
  }
  if (!sameShape(next.targets, existing.targets)) patch.targets = next.targets
  if (!sameShape(next.template, existing.template)) patch.template = next.template ?? null
  if (next.previewText !== existing.previewText && next.previewText !== undefined) {
    patch.previewText = next.previewText
  }
  if (next.previewMode !== existing.previewMode) patch.previewMode = next.previewMode
  if (!sameShape(next.reportClasses, existing.reportClasses)) {
    patch.reportClasses = next.reportClasses ?? []
  }
  if (next.priority !== existing.priority) patch.priority = next.priority
  return patch
}

// ── The arithmetic the operator is actually tuning ───────────────────

/**
 * What the renderer derives when `denseCadenceSec` is absent:
 * `max(1s, cadenceSec / 30)` — `resolveDenseCadence`'s own numbers.
 */
export function derivedDenseCadenceSec(cadenceSec: number): number {
  return Math.max(DENSE_DERIVED_FLOOR_SEC, cadenceSec / DENSE_CADENCE_DIVISOR)
}

/**
 * How long a detection passage lasts ON SCREEN:
 * `(rangeSec / denseCadenceSec) / framerate`.
 *
 * The one number that makes the dense knob comprehensible — a 7 s pass at 1 s
 * and 12 fps is 0.58 s of video, and halving the cadence doubles it.
 */
export function denseRangeOutputSeconds(
  rangeSec: number,
  denseCadenceSec: number,
  framerate: number,
): number {
  if (denseCadenceSec <= 0 || framerate <= 0) return 0
  return rangeSec / denseCadenceSec / framerate
}

/**
 * The SHORTEST passage that can still reach a dwell guarantee, in seconds.
 *
 * The guarantee is capped by real footage: at the recording's own frame
 * interval a passage shorter than `dwell × fps × floor` is rendered with every
 * frame it has and no more — never by duplicating frames into motion that never
 * happened.
 */
export function shortestPassForDwellSec(minDwellSec: number, framerate: number): number {
  return minDwellSec * framerate * TIMELAPSE_DENSE_FLOOR_SEC
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Why this rule could never produce a video. Every entry BLOCKS the save.
 *
 * The cadence pair mirrors `assertTimelapseCadences`, which the hub applies at
 * upsert for exactly this reason: the alternative is the export refusing the
 * pair at 06:05, when the window has closed and does not come back.
 */
export function timelapseFormProblems(form: TimelapseFormState): readonly string[] {
  const problems: string[] = []
  if (form.name.trim().length === 0) problems.push('Give the timelapse a name.')
  if (form.name.length > TIMELAPSE_NAME_MAX) {
    problems.push(`The name is at most ${TIMELAPSE_NAME_MAX} characters.`)
  }
  if (form.deviceIds.length === 0) {
    problems.push(
      'Pick at least one camera. Each camera renders its own video from its own recorded footage.',
    )
  }
  if (form.schedule === undefined || form.schedule.windows.length === 0) {
    problems.push(
      'A timelapse needs at least one time window — the video is assembled and delivered when that window CLOSES, so without one nothing is ever produced.',
    )
  }
  if (form.targetIds.length === 0) {
    problems.push('Pick at least one delivery target, or the video is rendered and never sent.')
  }
  if (
    !Number.isInteger(form.cadenceSec) ||
    form.cadenceSec < TIMELAPSE_CADENCE_MIN_SEC ||
    form.cadenceSec > TIMELAPSE_CADENCE_MAX_SEC
  ) {
    problems.push(
      `The cadence is a whole number of seconds between ${TIMELAPSE_CADENCE_MIN_SEC} and ${TIMELAPSE_CADENCE_MAX_SEC}.`,
    )
  }
  if (
    !Number.isInteger(form.framerate) ||
    form.framerate < TIMELAPSE_FRAMERATE_MIN ||
    form.framerate > TIMELAPSE_FRAMERATE_MAX
  ) {
    problems.push(
      `The output frame rate is a whole number between ${TIMELAPSE_FRAMERATE_MIN} and ${TIMELAPSE_FRAMERATE_MAX} fps.`,
    )
  }
  if (form.denseCadenceSec !== undefined) {
    if (
      form.denseCadenceSec < TIMELAPSE_DENSE_FLOOR_SEC ||
      form.denseCadenceSec > TIMELAPSE_DENSE_MAX_SEC
    ) {
      problems.push(
        `The dense cadence is between ${TIMELAPSE_DENSE_FLOOR_SEC}s and ${TIMELAPSE_DENSE_MAX_SEC}s.`,
      )
    } else if (form.denseCadenceSec >= form.cadenceSec) {
      // The hub's own `assertTimelapseCadences`, mirrored.
      problems.push(
        `The dense cadence (${form.denseCadenceSec}s) must be strictly smaller than the base cadence (${form.cadenceSec}s) — a dense cadence that is not denser renders a uniform timelapse.`,
      )
    }
  }
  if (
    form.minDwellSec !== undefined &&
    (form.minDwellSec < 0 || form.minDwellSec > TIMELAPSE_MIN_DWELL_MAX_SEC)
  ) {
    problems.push(`The minimum stay is between 0s and ${TIMELAPSE_MIN_DWELL_MAX_SEC}s.`)
  }
  if (form.previewText.length > TIMELAPSE_PREVIEW_TEXT_MAX) {
    problems.push(`The preview caption is at most ${TIMELAPSE_PREVIEW_TEXT_MAX} characters.`)
  }
  if (form.reportClasses.length > TIMELAPSE_REPORT_CLASSES_MAX) {
    problems.push(`At most ${TIMELAPSE_REPORT_CLASSES_MAX} counted classes.`)
  }
  if (form.priority < 1 || form.priority > 5) problems.push('Priority is between 1 and 5.')
  return problems
}

export function isTimelapseFormValid(form: TimelapseFormState): boolean {
  return timelapseFormProblems(form).length === 0
}

/** What is odd but still produceable. Shown, never blocking. */
export function timelapseFormWarnings(form: TimelapseFormState): readonly string[] {
  const warnings: string[] = []
  if (form.schedule?.invert === true) {
    warnings.push(
      'This schedule is inverted: the timelapse covers the time OUTSIDE the windows below.',
    )
  }
  if (form.minDwellSec !== undefined && form.minDwellSec > 0) {
    if (form.denseCadenceSec !== undefined) {
      warnings.push(
        'A minimum stay only ever DENSIFIES: where it needs more frames it samples faster than your dense cadence, which acts as the slowest it will go.',
      )
    }
    const shortest = shortestPassForDwellSec(form.minDwellSec, form.framerate)
    if (shortest > 3) {
      warnings.push(
        `A passage shorter than ${shortest.toFixed(1)}s can never reach this stay, even at the finest sampling — it is rendered with every frame that exists and no more.`,
      )
    }
  }
  if (form.previewMode === 'gif') {
    warnings.push(
      'A GIF preview costs a dozen extra seeks and a palette pass per delivery. If it cannot be assembled it degrades to the still — never to nothing.',
    )
  }
  return warnings
}

// ── Display ──────────────────────────────────────────────────────────

export function timelapseScheduleLabel(schedule: NcSchedule): string {
  return scheduleLabel(schedule)
}

/** When this rule last produced ANY camera's video. */
export function timelapseLastGeneratedLabel(
  lastGeneratedAt: number | undefined,
  nowMs: number,
): string {
  return agoLabel(lastGeneratedAt, nowMs, 'Never run')
}

/**
 * The dense cadence this rule will actually use, and where it came from — what
 * the editor prints beside the control so "Automatic" is never a blank.
 */
export interface DenseCadenceView {
  readonly seconds: number
  readonly derived: boolean
}

export function denseCadenceView(form: TimelapseFormState): DenseCadenceView {
  return form.denseCadenceSec === undefined
    ? { seconds: derivedDenseCadenceSec(form.cadenceSec), derived: true }
    : { seconds: form.denseCadenceSec, derived: false }
}

// ── Editor tabs ──────────────────────────────────────────────────────

/**
 * The Timelapse dialog's tabs — same chrome as Summaries / Rules.
 *
 * Operator request: the create modal was one long scroll of titled blocks next
 * to tabbed Summary and Rule editors, so three surfaces that author "when do I
 * get told about this" looked like three products. `fields` is DECLARED and
 * checked in the spec, exactly as `NC_SUMMARY_TABS` / `NC_RULE_TABS`.
 */
export type TimelapseTabKey = 'rule' | 'window' | 'sampling' | 'delivery'

export interface TimelapseTab {
  readonly key: TimelapseTabKey
  readonly label: string
  readonly fields: readonly (keyof TimelapseFormState)[]
}

export const NC_TIMELAPSE_TABS: readonly TimelapseTab[] = [
  {
    key: 'rule',
    get label() {
      return i18n.t('helpers.notificationTimelapse.tab_rule')
    },
    fields: ['name', 'enabled', 'deviceIds'],
  },
  {
    key: 'window',
    get label() {
      return i18n.t('helpers.notificationTimelapse.tab_window')
    },
    fields: ['schedule'],
  },
  {
    key: 'sampling',
    get label() {
      return i18n.t('helpers.notificationTimelapse.tab_sampling')
    },
    fields: ['cadenceSec', 'framerate', 'denseCadenceSec', 'minDwellSec'],
  },
  {
    key: 'delivery',
    get label() {
      return i18n.t('helpers.notificationTimelapse.tab_delivery')
    },
    fields: [
      'targetIds',
      'priority',
      'previewMode',
      'previewText',
      'previewTextSet',
      'templateTitle',
      'templateBody',
      'reportClasses',
    ],
  },
]

export const DEFAULT_TIMELAPSE_TAB: TimelapseTabKey = 'rule'

export function parseTimelapseTab(value: string): TimelapseTabKey | undefined {
  return NC_TIMELAPSE_TABS.find((tab) => tab.key === value)?.key
}
