/**
 * The Summaries tab's contract with the `nc.*SummaryRule*` bridge, narrowed by
 * hand — and the pure form model behind the editor.
 *
 * ## Why every field is re-declared here
 *
 * The summary rule's schema deliberately lives INSIDE `addon-post-analysis`
 * (`summary/summary-rule.ts`), not in `@camstack/types`: a field added there is
 * live on the next `camstack deploy` instead of the next framework train. The
 * price is that this client cannot import it, and `addons.custom` is typed
 * `z.unknown()` at the cap boundary. So the answer is narrowed HERE, in one
 * file, with type guards rather than casts — a hub too old to serve the actions,
 * or one that answered something unexpected, yields `null` and the tab SAYS so.
 * An empty table would read as "my rules are gone".
 *
 * `NcSchedule` and `NcRuleTarget` are the exceptions: both are ordinary
 * `@camstack/types` shapes that the rule embeds, and re-declaring them here
 * would be a second opinion about what a weekly window is.
 *
 * ## THE PATCH IS A DIFF — AND `ai` IS NOW ONE OF ITS KEYS
 *
 * `nc.upsertSummaryRule` merges `{ ...existing, ...patch }`. Every key the UI
 * sends therefore OVERWRITES the stored one, and every key it omits is left
 * alone. Through P1 the `ai` section was dormant and this file's rule was
 * "never name the key", because an editor that round-tripped a section it could
 * not express would erase it on the first rename.
 *
 * P2 makes the section real, so the rule inverts and gets stricter: the form
 * carries EVERY field of `NcSummaryAiSchema` (`enabled`, `profileId`, `prompt`,
 * `language`, `maxImagePx`, `timeoutMs`, `onFailure`) and the spec asserts the
 * round-trip, because a field the form drops is now a field the next save
 * deletes. `null` is the explicit clear, exactly as `filters` and `template`
 * already work.
 *
 * ## An unknown window kind is FLAGGED, never dropped
 *
 * A hub newer than this bundle can grow a third window kind. Refusing the whole
 * list would blank the tab; silently coercing it to `motion` would rewrite a
 * live rule on the next save (the failure `isRecognisedDelivery` exists for on
 * the rules page). It parses into `{ kind: 'unsupported' }`, renders read-only,
 * and cannot be opened in the editor.
 */

import type { NcRuleTarget, NcSchedule } from '@camstack/types'

import {
  agoLabel,
  formatSeconds,
  sameShape,
  scheduleLabel,
  targetsFromIds,
} from './notification-digest.helpers'
import i18n from '../../i18n/index'

// ── The bridge ───────────────────────────────────────────────────────

/** The addonId for `addons.custom` is the MANIFEST id, never the npm package. */
export { NC_ADDON_ID } from './notification-texts.helpers'

export const NC_LIST_SUMMARY_RULES_ACTION = 'nc.listSummaryRules'
export const NC_UPSERT_SUMMARY_RULE_ACTION = 'nc.upsertSummaryRule'
export const NC_DELETE_SUMMARY_RULE_ACTION = 'nc.deleteSummaryRule'
export const NC_TEST_SUMMARY_RULE_ACTION = 'nc.testSummaryRule'

// ── Bounds, mirrored from `summary-rule.ts` ──────────────────────────
//
// Mirrored rather than imported for the reason in the module docblock. They are
// here so the operator meets a disabled Save button and a sentence, instead of
// a Zod error string from the hub — and every one of them is asserted against
// the same numbers in the addon's own suite.

export const SUMMARY_MAX_TILES = 24
/** `NC_SUMMARY_DEFAULT_TILES` in addon-post-analysis `summary/summary-rule.ts`
 *  — not importable from here (addons never import each other, and it is not
 *  in `@camstack/types`). This editor SENDS it on create, so a stale copy
 *  retunes every new rule; the helpers spec pins it. */
export const SUMMARY_DEFAULT_TILES = 12
export const SUMMARY_MAX_AI_IMAGES = 8
export const SUMMARY_DEFAULT_AI_IMAGES = 6
export const SUMMARY_MAX_DEVICES = 64
export const SUMMARY_QUIET_SECONDS_MIN = 30
export const SUMMARY_QUIET_SECONDS_MAX = 3600
export const SUMMARY_MAX_WINDOW_SECONDS_MIN = 60
export const SUMMARY_MAX_WINDOW_SECONDS_MAX = 86_400
export const SUMMARY_BARRIER_SECONDS_MAX = 3600
export const SUMMARY_DEFAULT_BARRIER_SECONDS = 120
export const SUMMARY_MAX_DWELL_SECONDS = 3600
export const SUMMARY_MAX_CAPTION_LENGTH = 200

/** The window the Test button aims at: an explicit, recent, closed range. */
export const SUMMARY_TEST_LOOKBACK_MS = 3 * 3_600_000

export const SUMMARY_RANKS = ['importance', 'recency', 'dwell'] as const
export type SummaryRank = (typeof SUMMARY_RANKS)[number]

export const SUMMARY_RANK_LABELS: Readonly<Record<SummaryRank, string>> = {
  importance: 'Most important',
  recency: 'Most recent',
  dwell: 'Longest stay',
}

// ── What text the mosaic carries, mirrored from `NcSummaryCaptionsSchema` ──
//
// `none` FIRST, because it is the default and the order is the order an
// operator reads. The words are burnt into a durable artefact and cannot be
// removed afterwards, which is why "off" is the resting state rather than a
// preference.

export const SUMMARY_CAPTIONS = ['none', 'tiles', 'all'] as const
export type SummaryCaptions = (typeof SUMMARY_CAPTIONS)[number]

/** Absent on the wire ⇒ this. The hub materialises the same default. */
export const SUMMARY_DEFAULT_CAPTIONS: SummaryCaptions = 'none'

export const SUMMARY_CAPTIONS_LABELS: Readonly<Record<SummaryCaptions, string>> = {
  none: 'Images only — no text anywhere',
  tiles: 'A label under each tile',
  all: 'Tile labels and a caption across the top',
}

// ── The AI section's own vocabulary, mirrored from `NcSummaryAiSchema` ──

export const SUMMARY_AI_LANGUAGES = ['en', 'it'] as const
export type SummaryAiLanguage = (typeof SUMMARY_AI_LANGUAGES)[number]

export const SUMMARY_AI_ON_FAILURE = ['deliver-without-text', 'skip'] as const
export type SummaryAiOnFailure = (typeof SUMMARY_AI_ON_FAILURE)[number]

/** `timeoutMs` bounds, authored in the UI as SECONDS. */
export const SUMMARY_AI_TIMEOUT_SECONDS_MIN = 10
export const SUMMARY_AI_TIMEOUT_SECONDS_MAX = 600
export const SUMMARY_AI_MAX_IMAGE_PX_MIN = 64
export const SUMMARY_AI_MAX_IMAGE_PX_MAX = 2_048
export const SUMMARY_AI_MAX_PROMPT = 2_000

// ── The narrowed rule ────────────────────────────────────────────────

export interface SummaryTemplateView {
  readonly title?: string
  readonly body?: string
}

/** The `ai` section, narrowed field by field — see the module docblock. */
export interface SummaryAiView {
  readonly enabled: boolean
  readonly profileId?: string
  readonly prompt?: string
  readonly language?: SummaryAiLanguage
  readonly maxImagePx?: number
  readonly timeoutMs?: number
  readonly onFailure?: SummaryAiOnFailure
}

export interface SummaryFiltersView {
  readonly classes?: readonly string[]
  readonly classesExclude?: readonly string[]
  readonly zones?: readonly string[]
  readonly minImportance?: number
  readonly minDwellSeconds?: number
  /** Put PARKED objects in the digest too. Absent = off, which is the shipped
   *  reading of a rule authored before the option existed. */
  readonly includeStationary?: boolean
}

export interface SummaryScheduleWindowView {
  readonly kind: 'schedule'
  readonly schedule: NcSchedule
}

export interface SummaryMotionWindowView {
  readonly kind: 'motion'
  readonly quietSeconds: number
  readonly maxWindowSeconds: number
}

/** A window kind this build has no editor for — shown, never rewritten. */
export interface SummaryUnsupportedWindowView {
  readonly kind: 'unsupported'
  readonly raw: string
}

export type SummaryWindowView =
  | SummaryScheduleWindowView
  | SummaryMotionWindowView
  | SummaryUnsupportedWindowView

/** The editable half of the union — what {@link summaryRuleToForm} accepts. */
export type SummaryEditableWindow = SummaryScheduleWindowView | SummaryMotionWindowView

export interface SummaryRuleView {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly deviceIds: readonly number[]
  readonly window: SummaryWindowView
  readonly filters?: SummaryFiltersView
  readonly maxTiles: number
  readonly maxAiImages: number
  readonly rank: SummaryRank
  readonly barrierSeconds: number
  readonly targets: readonly NcRuleTarget[]
  readonly template?: SummaryTemplateView
  /** What text the mosaic carries. Never optional here: an absent wire field is
   *  narrowed to `none`, so the editor never has to guess. */
  readonly captions: SummaryCaptions
  readonly captionText?: string
  readonly deliverEmpty: boolean
  readonly priority: number
  /** Epoch-ms of the END of the last window delivered; absent = never run. */
  readonly generatedAt?: number
  /** Last write to the rule — the prune banner's "touched since" check. */
  readonly updatedAt?: number
  /** Admin-only authoring in v1 — every rule is read-only to everyone else. */
  readonly readOnly: boolean
  /** The joint-analysis section (#35 P2). Absent = the rule has none. */
  readonly ai?: SummaryAiView
}

/** A rule this build can open in the editor. */
export type SummaryEditableRule = SummaryRuleView & {
  readonly window: SummaryEditableWindow
}

export function isEditableSummaryRule(rule: SummaryRuleView): rule is SummaryEditableRule {
  return rule.window.kind !== 'unsupported' && !rule.readOnly
}

// ── Narrowing ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    out.push(item)
  }
  return out
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function optionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isSummaryRank(value: unknown): value is SummaryRank {
  return SUMMARY_RANKS.some((rank) => rank === value)
}

/**
 * The mosaic's text mode: absent ⇒ `none`, unknown ⇒ `null` (refuse the rule).
 *
 * Absent is the ORDINARY case and must not refuse anything — every rule
 * authored before the field existed has no key, and the hub reads those as
 * `none` too. An unknown value is the other case entirely: a mode a newer hub
 * grew. Coercing that to `none` would REWRITE the rule the next time the
 * operator renamed it, which is the exact trap `parseWindow` refuses for a
 * window kind, so it refuses here as well and the tab says it does not
 * understand rather than quietly editing.
 */
function parseCaptions(value: unknown): SummaryCaptions | null {
  if (value === undefined) return SUMMARY_DEFAULT_CAPTIONS
  return SUMMARY_CAPTIONS.find((c) => c === value) ?? null
}

/** The embedded `NcSchedule`, narrowed to what the schedule editor writes. */
function parseSchedule(raw: unknown): NcSchedule | null {
  if (!isRecord(raw)) return null
  if (!Array.isArray(raw['windows']) || raw['windows'].length === 0) return null
  const windows: NcSchedule['windows'] = []
  for (const item of raw['windows']) {
    if (!isRecord(item)) return null
    const days = numberArray(item['days'])
    const startMinute = item['startMinute']
    const endMinute = item['endMinute']
    if (days === null || days.length === 0) return null
    if (typeof startMinute !== 'number' || typeof endMinute !== 'number') return null
    windows.push({ days: [...days], startMinute, endMinute })
  }
  const timezone = optionalString(raw['timezone'])
  if (timezone === null) return null
  const invert = raw['invert']
  if (invert !== undefined && typeof invert !== 'boolean') return null
  return {
    windows,
    ...(timezone !== undefined ? { timezone } : {}),
    ...(invert === true ? { invert: true } : {}),
  }
}

function parseWindow(raw: unknown): SummaryWindowView | null {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string') return null
  if (raw['kind'] === 'schedule') {
    const schedule = parseSchedule(raw['schedule'])
    return schedule === null ? null : { kind: 'schedule', schedule }
  }
  if (raw['kind'] === 'motion') {
    const quietSeconds = raw['quietSeconds']
    const maxWindowSeconds = raw['maxWindowSeconds']
    if (typeof quietSeconds !== 'number' || typeof maxWindowSeconds !== 'number') return null
    return { kind: 'motion', quietSeconds, maxWindowSeconds }
  }
  // A kind this build has no editor for. Kept, flagged, never rewritten.
  return { kind: 'unsupported', raw: raw['kind'] }
}

function parseFilters(raw: unknown): SummaryFiltersView | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) return null
  const classes = raw['classes'] === undefined ? undefined : stringArray(raw['classes'])
  const classesExclude =
    raw['classesExclude'] === undefined ? undefined : stringArray(raw['classesExclude'])
  const zones = raw['zones'] === undefined ? undefined : stringArray(raw['zones'])
  if (classes === null || classesExclude === null || zones === null) return null
  const minImportance = optionalNumber(raw['minImportance'])
  const minDwellSeconds = optionalNumber(raw['minDwellSeconds'])
  if (minImportance === null || minDwellSeconds === null) return null
  // Only `true` is carried. A stored `false` and an absent key mean the same
  // thing — the producer reads `=== true` — and narrowing them to one shape
  // keeps `buildSummaryPatch`'s `sameShape` from seeing a difference that is
  // not one and writing a patch on every save.
  const includeStationary = raw['includeStationary']
  if (includeStationary !== undefined && typeof includeStationary !== 'boolean') return null
  return {
    ...(classes !== undefined ? { classes } : {}),
    ...(classesExclude !== undefined ? { classesExclude } : {}),
    ...(zones !== undefined ? { zones } : {}),
    ...(minImportance !== undefined ? { minImportance } : {}),
    ...(minDwellSeconds !== undefined ? { minDwellSeconds } : {}),
    ...(includeStationary === true ? { includeStationary: true } : {}),
  }
}

function parseTemplate(raw: unknown): SummaryTemplateView | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) return null
  const title = optionalString(raw['title'])
  const body = optionalString(raw['body'])
  if (title === null || body === null) return null
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}

function isAiLanguage(value: unknown): value is SummaryAiLanguage {
  return SUMMARY_AI_LANGUAGES.some((l) => l === value)
}

function isAiOnFailure(value: unknown): value is SummaryAiOnFailure {
  return SUMMARY_AI_ON_FAILURE.some((v) => v === value)
}

/**
 * The `ai` section, or `undefined` when the rule has none, or `null` when the
 * hub answered something this build cannot read.
 *
 * `null` REFUSES the whole rule rather than dropping the section, and that is
 * the important half: now that the editor WRITES `ai`, a section silently
 * dropped on read would be a section deleted on the next save.
 */
function parseAi(raw: unknown): SummaryAiView | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return null
  const profileId = optionalString(raw['profileId'])
  const prompt = optionalString(raw['prompt'])
  if (profileId === null || prompt === null) return null
  const maxImagePx = optionalNumber(raw['maxImagePx'])
  const timeoutMs = optionalNumber(raw['timeoutMs'])
  if (maxImagePx === null || timeoutMs === null) return null
  const language = raw['language']
  if (language !== undefined && !isAiLanguage(language)) return null
  const onFailure = raw['onFailure']
  if (onFailure !== undefined && !isAiOnFailure(onFailure)) return null
  return {
    enabled: raw['enabled'],
    ...(profileId !== undefined ? { profileId } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(maxImagePx !== undefined ? { maxImagePx } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(onFailure !== undefined ? { onFailure } : {}),
  }
}

function parseTargets(raw: unknown): readonly NcRuleTarget[] | null {
  if (!Array.isArray(raw)) return null
  const out: NcRuleTarget[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item['targetId'] !== 'string') return null
    const params = item['params']
    if (params !== undefined && !isRecord(params)) return null
    out.push({
      targetId: item['targetId'],
      ...(params !== undefined ? { params } : {}),
    })
  }
  return out
}

function parseRule(raw: unknown): SummaryRuleView | null {
  if (!isRecord(raw)) return null
  const { id, name, enabled, maxTiles, maxAiImages, rank, barrierSeconds, deliverEmpty } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof name !== 'string' || typeof enabled !== 'boolean') return null
  if (typeof maxTiles !== 'number' || typeof maxAiImages !== 'number') return null
  if (!isSummaryRank(rank) || typeof barrierSeconds !== 'number') return null
  if (typeof deliverEmpty !== 'boolean' || typeof raw['priority'] !== 'number') return null
  const deviceIds = numberArray(raw['deviceIds'])
  const window = parseWindow(raw['window'])
  const targets = parseTargets(raw['targets'])
  if (deviceIds === null || window === null || targets === null) return null
  const filters = parseFilters(raw['filters'])
  const template = parseTemplate(raw['template'])
  if (filters === null || template === null) return null
  const captionText = optionalString(raw['captionText'])
  const generatedAt = optionalNumber(raw['generatedAt'])
  const updatedAt = optionalNumber(raw['updatedAt'])
  if (captionText === null || generatedAt === null || updatedAt === null) return null
  const captions = parseCaptions(raw['captions'])
  if (captions === null) return null
  const ai = parseAi(raw['ai'])
  if (ai === null) return null
  return {
    id,
    name,
    enabled,
    deviceIds,
    window,
    ...(filters !== undefined ? { filters } : {}),
    maxTiles,
    maxAiImages,
    rank,
    barrierSeconds,
    targets,
    ...(template !== undefined ? { template } : {}),
    captions,
    ...(captionText !== undefined ? { captionText } : {}),
    deliverEmpty,
    priority: raw['priority'],
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    readOnly: raw['readOnly'] === true,
    ...(ai !== undefined ? { ai } : {}),
  }
}

/**
 * Narrow the `nc.listSummaryRules` answer. `null` on anything unexpected —
 * including a hub that has the action but answered a shape this build cannot
 * read. An EMPTY list is an answer, not a failure.
 */
export function parseSummaryRules(raw: unknown): readonly SummaryRuleView[] | null {
  if (!isRecord(raw) || !Array.isArray(raw['rules'])) return null
  const rules: SummaryRuleView[] = []
  for (const item of raw['rules']) {
    const rule = parseRule(item)
    if (rule === null) return null
    rules.push(rule)
  }
  return rules
}

/** What one `nc.testSummaryRule` run reported. */
export interface SummaryTestOutcome {
  readonly produced: number
  readonly tiles?: number
  readonly cameras?: number
  readonly matched?: number
  /** Parked objects the window held and the rule dropped — the number that
   *  tells a thin digest apart from a quiet night. */
  readonly droppedStationary?: number
  readonly enqueued?: number
  readonly mosaicBytes?: number
  readonly mosaicUrl?: string
  readonly windowStartMs?: number
  readonly windowEndMs?: number
  readonly error?: string
  /** What the AI pass did (#35 P2) — see `nc.testSummaryRule`. */
  readonly aiText?: string
  readonly aiFailure?: string
  readonly aiImages?: number
  /** The window was produced and WITHHELD by `ai.onFailure: 'skip'`. */
  readonly skippedByAi?: boolean
}

export function parseSummaryTestOutcome(raw: unknown): SummaryTestOutcome | null {
  if (!isRecord(raw) || typeof raw['produced'] !== 'number') return null
  const numbers = [
    'tiles',
    'cameras',
    'matched',
    'droppedStationary',
    'enqueued',
    'mosaicBytes',
    'aiImages',
  ] as const
  const out: Record<string, number | string> = { produced: raw['produced'] }
  for (const key of numbers) {
    const value = optionalNumber(raw[key])
    if (value === null) return null
    if (value !== undefined) out[key] = value
  }
  for (const key of ['windowStartMs', 'windowEndMs'] as const) {
    const value = optionalNumber(raw[key])
    if (value === null) return null
    if (value !== undefined) out[key] = value
  }
  for (const key of ['mosaicUrl', 'error', 'aiText', 'aiFailure'] as const) {
    const value = optionalString(raw[key])
    if (value === null) return null
    if (value !== undefined) out[key] = value
  }
  return {
    produced: raw['produced'],
    ...(typeof out['tiles'] === 'number' ? { tiles: out['tiles'] } : {}),
    ...(typeof out['cameras'] === 'number' ? { cameras: out['cameras'] } : {}),
    ...(typeof out['matched'] === 'number' ? { matched: out['matched'] } : {}),
    ...(typeof out['droppedStationary'] === 'number'
      ? { droppedStationary: out['droppedStationary'] }
      : {}),
    ...(typeof out['enqueued'] === 'number' ? { enqueued: out['enqueued'] } : {}),
    ...(typeof out['mosaicBytes'] === 'number' ? { mosaicBytes: out['mosaicBytes'] } : {}),
    ...(typeof out['mosaicUrl'] === 'string' ? { mosaicUrl: out['mosaicUrl'] } : {}),
    ...(typeof out['windowStartMs'] === 'number' ? { windowStartMs: out['windowStartMs'] } : {}),
    ...(typeof out['windowEndMs'] === 'number' ? { windowEndMs: out['windowEndMs'] } : {}),
    ...(typeof out['error'] === 'string' ? { error: out['error'] } : {}),
    ...(typeof out['aiText'] === 'string' ? { aiText: out['aiText'] } : {}),
    ...(typeof out['aiFailure'] === 'string' ? { aiFailure: out['aiFailure'] } : {}),
    ...(typeof out['aiImages'] === 'number' ? { aiImages: out['aiImages'] } : {}),
    ...(raw['skippedByAi'] === true ? { skippedByAi: true } : {}),
  }
}

// ── The form ─────────────────────────────────────────────────────────

export interface SummaryFormState {
  readonly name: string
  readonly enabled: boolean
  readonly deviceIds: readonly number[]
  readonly windowKind: 'schedule' | 'motion'
  /** Only meaningful for `windowKind: 'schedule'`; `undefined` = no window. */
  readonly schedule: NcSchedule | undefined
  readonly quietSeconds: number
  readonly maxWindowSeconds: number
  readonly classes: readonly string[]
  readonly classesExclude: readonly string[]
  readonly zones: readonly string[]
  readonly minImportance: number | undefined
  readonly minDwellSeconds: number | undefined
  /** Put PARKED objects in the digest too — off by default (a digest is a
   *  record of passages). See the switch on the "What goes in" tab. */
  readonly includeStationary: boolean
  readonly maxTiles: number
  readonly maxAiImages: number
  readonly rank: SummaryRank
  readonly barrierSeconds: number
  readonly targetIds: readonly string[]
  readonly templateTitle: string
  readonly templateBody: string
  /** What text the mosaic carries. `none` — pictures only — is the default. */
  readonly mosaicCaptions: SummaryCaptions
  /** Only drawn when `mosaicCaptions` is `all`; kept either way, so switching
   *  the words back on does not cost the operator the words he wrote. */
  readonly captionText: string
  readonly deliverEmpty: boolean
  readonly priority: number
  // ── The AI section (#35 P2) ────────────────────────────────────────
  //
  // EVERY field of `NcSummaryAiSchema` has a home here. That is not tidiness:
  // the patch writes `ai` as a whole object, so a field with no form home is a
  // field the next save deletes.
  readonly aiEnabled: boolean
  /** `''` = whatever `llm` resolves for the `ai-summary` consumer. */
  readonly aiProfileId: string
  /** `''` = the shipped question. */
  readonly aiPrompt: string
  /** `''` = the model's default (English). */
  readonly aiLanguage: SummaryAiLanguage | ''
  readonly aiMaxImagePx: number | undefined
  /** SECONDS in the UI, milliseconds on the wire — nobody types 180000. */
  readonly aiTimeoutSeconds: number | undefined
  readonly aiOnFailure: SummaryAiOnFailure
}

/** The defaults a NEW digest opens on — the addon's own, verbatim. */
export function emptySummaryForm(): SummaryFormState {
  return {
    name: '',
    enabled: true,
    deviceIds: [],
    windowKind: 'motion',
    schedule: undefined,
    quietSeconds: 60,
    maxWindowSeconds: 300,
    classes: [],
    classesExclude: [],
    zones: [],
    minImportance: undefined,
    minDwellSeconds: undefined,
    // OFF: the digest is a record of passages, and the operator's report is
    // that parked objects were filling it.
    includeStationary: false,
    maxTiles: SUMMARY_DEFAULT_TILES,
    maxAiImages: SUMMARY_DEFAULT_AI_IMAGES,
    rank: 'importance',
    barrierSeconds: SUMMARY_DEFAULT_BARRIER_SECONDS,
    targetIds: [],
    templateTitle: '',
    templateBody: '',
    mosaicCaptions: SUMMARY_DEFAULT_CAPTIONS,
    captionText: '',
    deliverEmpty: false,
    priority: 3,
    aiEnabled: false,
    aiProfileId: '',
    aiPrompt: '',
    aiLanguage: '',
    aiMaxImagePx: undefined,
    aiTimeoutSeconds: undefined,
    // The default is the one that cannot cost a digest.
    aiOnFailure: 'deliver-without-text',
  }
}

export function summaryRuleToForm(rule: SummaryEditableRule): SummaryFormState {
  const base = emptySummaryForm()
  const motion = rule.window.kind === 'motion' ? rule.window : null
  return {
    name: rule.name,
    enabled: rule.enabled,
    deviceIds: [...rule.deviceIds],
    windowKind: rule.window.kind,
    schedule: rule.window.kind === 'schedule' ? rule.window.schedule : undefined,
    quietSeconds: motion?.quietSeconds ?? base.quietSeconds,
    maxWindowSeconds: motion?.maxWindowSeconds ?? base.maxWindowSeconds,
    classes: [...(rule.filters?.classes ?? [])],
    classesExclude: [...(rule.filters?.classesExclude ?? [])],
    zones: [...(rule.filters?.zones ?? [])],
    minImportance: rule.filters?.minImportance,
    minDwellSeconds: rule.filters?.minDwellSeconds,
    includeStationary: rule.filters?.includeStationary === true,
    maxTiles: rule.maxTiles,
    maxAiImages: rule.maxAiImages,
    rank: rule.rank,
    barrierSeconds: rule.barrierSeconds,
    targetIds: rule.targets.map((t) => t.targetId),
    templateTitle: rule.template?.title ?? '',
    templateBody: rule.template?.body ?? '',
    mosaicCaptions: rule.captions,
    captionText: rule.captionText ?? '',
    deliverEmpty: rule.deliverEmpty,
    priority: rule.priority,
    aiEnabled: rule.ai?.enabled ?? base.aiEnabled,
    aiProfileId: rule.ai?.profileId ?? '',
    aiPrompt: rule.ai?.prompt ?? '',
    aiLanguage: rule.ai?.language ?? '',
    aiMaxImagePx: rule.ai?.maxImagePx,
    aiTimeoutSeconds:
      rule.ai?.timeoutMs === undefined ? undefined : Math.round(rule.ai.timeoutMs / 1000),
    aiOnFailure: rule.ai?.onFailure ?? base.aiOnFailure,
  }
}

// ── What goes on the wire ────────────────────────────────────────────

export type SummaryWindowWire = SummaryScheduleWindowView | SummaryMotionWindowView

export interface SummaryRuleInputWire {
  readonly name: string
  readonly enabled: boolean
  readonly deviceIds: readonly number[]
  readonly window: SummaryWindowWire
  readonly filters?: SummaryFiltersView
  readonly maxTiles: number
  readonly maxAiImages: number
  readonly rank: SummaryRank
  readonly barrierSeconds: number
  readonly targets: readonly NcRuleTarget[]
  readonly template?: SummaryTemplateView
  readonly captions: SummaryCaptions
  readonly captionText?: string
  readonly deliverEmpty: boolean
  readonly priority: number
  readonly ai?: SummaryAiView
}

/**
 * The partial update. `filters`, `template` and `ai` are the three CLEARABLE
 * fields — `null` removes them, an object replaces them, an absent key leaves
 * them alone.
 */
export interface SummaryRulePatchWire {
  readonly name?: string
  readonly enabled?: boolean
  readonly deviceIds?: readonly number[]
  readonly window?: SummaryWindowWire
  readonly filters?: SummaryFiltersView | null
  readonly maxTiles?: number
  readonly maxAiImages?: number
  readonly rank?: SummaryRank
  readonly barrierSeconds?: number
  readonly targets?: readonly NcRuleTarget[]
  readonly template?: SummaryTemplateView | null
  readonly captions?: SummaryCaptions
  readonly captionText?: string
  readonly deliverEmpty?: boolean
  readonly priority?: number
  readonly ai?: SummaryAiView | null
}

function formWindow(form: SummaryFormState): SummaryWindowWire {
  if (form.windowKind === 'schedule' && form.schedule !== undefined) {
    return { kind: 'schedule', schedule: form.schedule }
  }
  return {
    kind: 'motion',
    quietSeconds: form.quietSeconds,
    maxWindowSeconds: form.maxWindowSeconds,
  }
}

/** The filters the form expresses, or `undefined` when it expresses none. */
function formFilters(form: SummaryFormState): SummaryFiltersView | undefined {
  const filters: SummaryFiltersView = {
    ...(form.classes.length > 0 ? { classes: [...form.classes] } : {}),
    ...(form.classesExclude.length > 0 ? { classesExclude: [...form.classesExclude] } : {}),
    ...(form.zones.length > 0 ? { zones: [...form.zones] } : {}),
    ...(form.minImportance !== undefined ? { minImportance: form.minImportance } : {}),
    ...(form.minDwellSeconds !== undefined ? { minDwellSeconds: form.minDwellSeconds } : {}),
    // Named ONLY when on. Off is the default AND the reading of an absent
    // field, so writing `false` would store a key that changes nothing and
    // would make an otherwise filter-free rule carry a `filters` object.
    ...(form.includeStationary ? { includeStationary: true } : {}),
  }
  return Object.keys(filters).length === 0 ? undefined : filters
}

function formTemplate(form: SummaryFormState): SummaryTemplateView | undefined {
  const title = form.templateTitle.trim()
  const body = form.templateBody.trim()
  if (title.length === 0 && body.length === 0) return undefined
  return {
    ...(title.length > 0 ? { title } : {}),
    ...(body.length > 0 ? { body } : {}),
  }
}

function formTargets(form: SummaryFormState): readonly NcRuleTarget[] {
  return targetsFromIds(form.targetIds)
}

/**
 * The AI section the form expresses, or `undefined` when it expresses none.
 *
 * "None" is NOT the same as "off": an operator who switches AI off for a week
 * must find his prompt where he left it, so a section is only absent when the
 * switch is off AND nothing else in it was ever authored. That distinction is
 * what makes `null` (clear) an operator gesture rather than a side effect of
 * flipping a toggle.
 */
function formAi(form: SummaryFormState): SummaryAiView | undefined {
  const profileId = form.aiProfileId.trim()
  const prompt = form.aiPrompt.trim()
  const configured =
    profileId.length > 0 ||
    prompt.length > 0 ||
    form.aiLanguage !== '' ||
    form.aiMaxImagePx !== undefined ||
    form.aiTimeoutSeconds !== undefined ||
    form.aiOnFailure !== 'deliver-without-text'
  if (!form.aiEnabled && !configured) return undefined
  return {
    enabled: form.aiEnabled,
    ...(profileId.length > 0 ? { profileId } : {}),
    ...(prompt.length > 0 ? { prompt } : {}),
    ...(form.aiLanguage !== '' ? { language: form.aiLanguage } : {}),
    ...(form.aiMaxImagePx !== undefined ? { maxImagePx: form.aiMaxImagePx } : {}),
    ...(form.aiTimeoutSeconds !== undefined
      ? { timeoutMs: Math.round(form.aiTimeoutSeconds * 1000) }
      : {}),
    ...(form.aiOnFailure !== 'deliver-without-text' ? { onFailure: form.aiOnFailure } : {}),
  }
}

export function buildSummaryCreateInput(form: SummaryFormState): SummaryRuleInputWire {
  const filters = formFilters(form)
  const template = formTemplate(form)
  const ai = formAi(form)
  const caption = form.captionText.trim()
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    deviceIds: [...form.deviceIds],
    window: formWindow(form),
    ...(filters !== undefined ? { filters } : {}),
    maxTiles: form.maxTiles,
    maxAiImages: form.maxAiImages,
    rank: form.rank,
    barrierSeconds: form.barrierSeconds,
    targets: formTargets(form),
    ...(template !== undefined ? { template } : {}),
    captions: form.mosaicCaptions,
    ...(caption.length > 0 ? { captionText: caption } : {}),
    deliverEmpty: form.deliverEmpty,
    priority: form.priority,
    ...(ai !== undefined ? { ai } : {}),
  }
}

/**
 * ONLY what the operator changed.
 *
 * The upsert merges the patch over the stored rule, so an omitted key is a
 * preserved key. That is what keeps a rename to exactly `{ name }` — and, for
 * `ai` specifically, what makes the form's completeness load-bearing: the key
 * is only named when the SECTION differs, and when it is named it replaces the
 * stored one whole.
 */
export function buildSummaryPatch(
  form: SummaryFormState,
  existing: SummaryEditableRule,
): SummaryRulePatchWire {
  const next = buildSummaryCreateInput(form)
  const patch: {
    name?: string
    enabled?: boolean
    deviceIds?: readonly number[]
    window?: SummaryWindowWire
    filters?: SummaryFiltersView | null
    maxTiles?: number
    maxAiImages?: number
    rank?: SummaryRank
    barrierSeconds?: number
    targets?: readonly NcRuleTarget[]
    template?: SummaryTemplateView | null
    captions?: SummaryCaptions
    captionText?: string
    deliverEmpty?: boolean
    priority?: number
    ai?: SummaryAiView | null
  } = {}

  if (next.name !== existing.name) patch.name = next.name
  if (next.enabled !== existing.enabled) patch.enabled = next.enabled
  if (!sameShape(next.deviceIds, existing.deviceIds)) patch.deviceIds = next.deviceIds
  if (!sameShape(next.window, existing.window)) patch.window = next.window
  if (!sameShape(next.filters, existing.filters)) {
    // An absent filter set on a rule that HAD one is a clear, not a no-op.
    patch.filters = next.filters ?? null
  }
  if (next.maxTiles !== existing.maxTiles) patch.maxTiles = next.maxTiles
  if (next.maxAiImages !== existing.maxAiImages) patch.maxAiImages = next.maxAiImages
  if (next.rank !== existing.rank) patch.rank = next.rank
  if (next.barrierSeconds !== existing.barrierSeconds) patch.barrierSeconds = next.barrierSeconds
  if (!sameShape(next.targets, existing.targets)) patch.targets = next.targets
  if (!sameShape(next.template, existing.template)) patch.template = next.template ?? null
  if (next.captions !== existing.captions) patch.captions = next.captions
  if ((next.captionText ?? '') !== (existing.captionText ?? '')) {
    // `''` is reachable and means "no caption" — which is why it is sent as an
    // empty string rather than omitted.
    patch.captionText = next.captionText ?? ''
  }
  if (next.deliverEmpty !== existing.deliverEmpty) patch.deliverEmpty = next.deliverEmpty
  if (next.priority !== existing.priority) patch.priority = next.priority
  if (!sameShape(next.ai, existing.ai)) {
    // A form that expresses no section on a rule that HAD one is a clear, not a
    // no-op — the same treatment `filters` and `template` already get.
    patch.ai = next.ai ?? null
  }
  return patch
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Why this rule could never produce a digest. Every entry BLOCKS the save.
 *
 * Failing at save time is the whole point: the alternative is a rule that is
 * stored, enabled and permanently silent, discovered at 07:05 when the window
 * has already closed and cannot come back.
 */
export function summaryFormProblems(form: SummaryFormState): readonly string[] {
  const problems: string[] = []
  if (form.name.trim().length === 0) {
    problems.push('Give the digest a name — it is what the notification is signed with.')
  }
  if (form.deviceIds.length === 0) {
    problems.push('Pick at least one camera. A digest with no camera has nothing to collect.')
  }
  if (form.deviceIds.length > SUMMARY_MAX_DEVICES) {
    problems.push(`A digest spans at most ${SUMMARY_MAX_DEVICES} cameras.`)
  }
  if (form.targetIds.length === 0) {
    problems.push('Pick at least one delivery target, or the digest is rendered and never sent.')
  }
  if (form.windowKind === 'schedule' && form.schedule === undefined) {
    problems.push(
      'A scheduled digest needs at least one time window — the digest is produced when that window CLOSES, so without one nothing ever closes.',
    )
  }
  if (form.windowKind === 'motion') {
    if (
      form.quietSeconds < SUMMARY_QUIET_SECONDS_MIN ||
      form.quietSeconds > SUMMARY_QUIET_SECONDS_MAX
    ) {
      problems.push(
        `The quiet period must be between ${SUMMARY_QUIET_SECONDS_MIN}s and ${SUMMARY_QUIET_SECONDS_MAX}s.`,
      )
    }
    if (
      form.maxWindowSeconds < SUMMARY_MAX_WINDOW_SECONDS_MIN ||
      form.maxWindowSeconds > SUMMARY_MAX_WINDOW_SECONDS_MAX
    ) {
      problems.push(
        `The longest window must be between ${SUMMARY_MAX_WINDOW_SECONDS_MIN}s and ${SUMMARY_MAX_WINDOW_SECONDS_MAX}s.`,
      )
    }
  }
  if (form.maxTiles < 1 || form.maxTiles > SUMMARY_MAX_TILES) {
    problems.push(`The mosaic holds between 1 and ${SUMMARY_MAX_TILES} tiles.`)
  }
  if (form.maxAiImages > form.maxTiles) {
    // The server's own `assertSummaryBudget`, mirrored word for word.
    problems.push(
      `AI images (${form.maxAiImages}) cannot exceed tiles (${form.maxTiles}) — the model cannot judge frames the mosaic does not contain.`,
    )
  }
  if (form.barrierSeconds < 0 || form.barrierSeconds > SUMMARY_BARRIER_SECONDS_MAX) {
    problems.push(`The track-close wait is between 0s and ${SUMMARY_BARRIER_SECONDS_MAX}s.`)
  }
  if (form.minImportance !== undefined && (form.minImportance < 0 || form.minImportance > 1)) {
    problems.push('Minimum importance is a score between 0 and 1.')
  }
  if (
    form.minDwellSeconds !== undefined &&
    (form.minDwellSeconds < 0 || form.minDwellSeconds > SUMMARY_MAX_DWELL_SECONDS)
  ) {
    problems.push(`Minimum stay is between 0s and ${SUMMARY_MAX_DWELL_SECONDS}s.`)
  }
  if (form.captionText.length > SUMMARY_MAX_CAPTION_LENGTH) {
    problems.push(`The caption is at most ${SUMMARY_MAX_CAPTION_LENGTH} characters.`)
  }
  if (form.priority < 1 || form.priority > 5) problems.push('Priority is between 1 and 5.')
  if (form.aiPrompt.length > SUMMARY_AI_MAX_PROMPT) {
    problems.push(`The AI question is at most ${SUMMARY_AI_MAX_PROMPT} characters.`)
  }
  if (
    form.aiTimeoutSeconds !== undefined &&
    (form.aiTimeoutSeconds < SUMMARY_AI_TIMEOUT_SECONDS_MIN ||
      form.aiTimeoutSeconds > SUMMARY_AI_TIMEOUT_SECONDS_MAX)
  ) {
    problems.push(
      `The AI time limit is between ${SUMMARY_AI_TIMEOUT_SECONDS_MIN}s and ${SUMMARY_AI_TIMEOUT_SECONDS_MAX}s.`,
    )
  }
  if (
    form.aiMaxImagePx !== undefined &&
    (form.aiMaxImagePx < SUMMARY_AI_MAX_IMAGE_PX_MIN ||
      form.aiMaxImagePx > SUMMARY_AI_MAX_IMAGE_PX_MAX)
  ) {
    problems.push(
      `The AI frame size is between ${SUMMARY_AI_MAX_IMAGE_PX_MIN} and ${SUMMARY_AI_MAX_IMAGE_PX_MAX} pixels.`,
    )
  }
  const excluded = new Set(form.classesExclude)
  if (form.classes.length > 0 && form.classes.every((c) => excluded.has(c))) {
    problems.push(
      'Every class this digest includes is also excluded, so no track can ever become a tile.',
    )
  }
  return problems
}

export function isSummaryFormValid(form: SummaryFormState): boolean {
  return summaryFormProblems(form).length === 0
}

/**
 * What is odd but still deliverable. Shown, never blocking — a warning that
 * blocks is a rule, and a rule the operator cannot override is not a warning.
 */
export function summaryFormWarnings(form: SummaryFormState): readonly string[] {
  const warnings: string[] = []
  if (form.windowKind === 'motion' && form.quietSeconds >= form.maxWindowSeconds) {
    warnings.push(
      'The quiet period is at least as long as the longest window, so it can never close one: every window will run to the ceiling instead.',
    )
  }
  const excluded = new Set(form.classesExclude)
  const both = form.classes.filter((c) => excluded.has(c))
  if (both.length > 0 && both.length < form.classes.length) {
    warnings.push(
      `Excluded and included at the same time — the exclusion wins: ${both.join(', ')}.`,
    )
  }
  if (form.windowKind === 'schedule' && form.schedule?.invert === true) {
    warnings.push(
      'This schedule is inverted: the digest covers the time OUTSIDE the windows below.',
    )
  }
  if (form.deviceIds.length === 1) {
    warnings.push(
      'One camera is allowed, but a digest is a MULTI-camera artefact — with one camera a timelapse rule is usually the better tool.',
    )
  }
  if (form.aiEnabled && form.aiOnFailure === 'skip') {
    // The one AI setting that can lose a window permanently. Said out loud,
    // because "skip" reads as "skip the text" and it is not.
    warnings.push(
      'With “hold the digest” selected, a window whose AI pass fails is NOT delivered at all — no mosaic, no counts — and the window does not come back.',
    )
  }
  return warnings
}

// ── The editor's tabs ────────────────────────────────────────────────

/**
 * The digest dialog's tabs, in the order an operator meets them.
 *
 * Operator report on the screenshot: *"non ci sono sezioni organizzate"*. The
 * dialog was one long scroll of titled blocks, next to a detection-rule editor
 * that has had tabs since 2026-08-04 — so the two surfaces that author "when do
 * I get told about this" looked like two different products.
 *
 * `fields` is DECLARED and checked in the spec, exactly as `NC_RULE_TABS` is: a
 * field no tab claims is a field the operator can no longer edit, silently,
 * because the form still round-trips it.
 */
export type SummaryTabKey = 'rule' | 'window' | 'content' | 'mosaic' | 'ai' | 'delivery'

export interface SummaryTab {
  readonly key: SummaryTabKey
  readonly label: string
  readonly fields: readonly (keyof SummaryFormState)[]
}

export const NC_SUMMARY_TABS: readonly SummaryTab[] = [
  {
    key: 'rule',
    get label() {
      return i18n.t('helpers.notificationSummaries.tab_rule')
    },
    fields: ['name', 'enabled', 'deviceIds'],
  },
  {
    key: 'window',
    get label() {
      return i18n.t('helpers.notificationSummaries.tab_window')
    },
    fields: ['windowKind', 'schedule', 'quietSeconds', 'maxWindowSeconds', 'barrierSeconds'],
  },
  {
    key: 'content',
    get label() {
      return i18n.t('helpers.notificationSummaries.tab_content')
    },
    fields: [
      'classes',
      'classesExclude',
      'zones',
      'minImportance',
      'minDwellSeconds',
      'includeStationary',
    ],
  },
  {
    key: 'mosaic',
    get label() {
      return i18n.t('helpers.notificationSummaries.tab_mosaic')
    },
    fields: ['maxTiles', 'rank', 'mosaicCaptions', 'captionText'],
  },
  {
    key: 'ai',
    label: 'AI',
    fields: [
      'aiEnabled',
      'aiProfileId',
      'aiPrompt',
      'aiLanguage',
      'aiMaxImagePx',
      'aiTimeoutSeconds',
      'aiOnFailure',
      // The AI budget lives on the AI tab, not the mosaic one: it is bounded
      // by the model's time limit, not by pixels, and an operator tuning the
      // model must see it beside the switch that turns the model on.
      'maxAiImages',
    ],
  },
  {
    key: 'delivery',
    get label() {
      return i18n.t('helpers.notificationSummaries.tab_delivery')
    },
    fields: ['targetIds', 'priority', 'deliverEmpty', 'templateTitle', 'templateBody'],
  },
]

/** The tab the dialog opens on — the common case, always. */
export const DEFAULT_SUMMARY_TAB: SummaryTabKey = 'rule'

/** Narrow the tab primitive's raw string, else undefined (keep the current
 *  tab rather than blanking the dialog). */
export function parseSummaryTab(value: string): SummaryTabKey | undefined {
  return NC_SUMMARY_TABS.find((tab) => tab.key === value)?.key
}

// ── Display ──────────────────────────────────────────────────────────

/** One line describing the window, for the list. */
export function summaryWindowLabel(window: SummaryWindowView): string {
  if (window.kind === 'motion') {
    return i18n.t('helpers.notificationSummaries.winMotion', {
      quiet: formatSeconds(window.quietSeconds),
      max: formatSeconds(window.maxWindowSeconds),
    })
  }
  if (window.kind === 'unsupported') {
    return i18n.t('helpers.notificationSummaries.winUnsupported', { raw: window.raw })
  }
  return i18n.t('helpers.notificationSummaries.winSchedule', {
    schedule: scheduleLabel(window.schedule),
  })
}

/** When this rule last DELIVERED. "Never" in words — never a dash. */
export function summaryLastGeneratedLabel(generatedAt: number | undefined, nowMs: number): string {
  return agoLabel(generatedAt, nowMs, 'Never run')
}

/** The filter set, in one cell. */
export function summaryFilterLabel(filters: SummaryFiltersView | undefined): string {
  // "All passages", not "all tracks": parked objects are out unless the rule
  // says otherwise, and a label that claimed everything would misdescribe every
  // rule on the list.
  if (filters === undefined) return i18n.t('helpers.notificationSummaries.allPassages')
  const parts: string[] = []
  if (filters.classes !== undefined && filters.classes.length > 0) {
    parts.push(filters.classes.join(', '))
  }
  if (filters.classesExclude !== undefined && filters.classesExclude.length > 0) {
    parts.push(
      i18n.t('helpers.notificationSummaries.filterNot', {
        classes: filters.classesExclude.join(', '),
      }),
    )
  }
  if (filters.zones !== undefined && filters.zones.length > 0) {
    parts.push(i18n.t('helpers.notificationSummaries.filterZones', { count: filters.zones.length }))
  }
  if (filters.minImportance !== undefined)
    parts.push(
      i18n.t('helpers.notificationSummaries.filterImportance', { value: filters.minImportance }),
    )
  if (filters.minDwellSeconds !== undefined) {
    parts.push(
      i18n.t('helpers.notificationSummaries.filterStay', {
        value: formatSeconds(filters.minDwellSeconds),
      }),
    )
  }
  if (filters.includeStationary === true)
    parts.push(i18n.t('helpers.notificationSummaries.filterParked'))
  return parts.length === 0
    ? i18n.t('helpers.notificationSummaries.allPassages')
    : parts.join(' · ')
}

export interface SummaryTestWindow {
  readonly windowStartMs: number
  readonly windowEndMs: number
}

/**
 * The Test button's window: an EXPLICIT recent range rather than "whatever the
 * rule's last closed window was". A motion rule that has seen nothing has no
 * window at all, and a test that answers "no window has closed recently" tests
 * nothing the operator asked about.
 */
export function summaryTestWindow(nowMs: number): SummaryTestWindow {
  return {
    windowStartMs: nowMs - SUMMARY_TEST_LOOKBACK_MS,
    windowEndMs: nowMs,
  }
}
