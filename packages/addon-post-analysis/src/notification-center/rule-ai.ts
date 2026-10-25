/**
 * `NcRuleAi` — the AI section of an ORDINARY notification rule.
 *
 * The digest got its analyst first (`summary/summary-ai.ts`), and everything it
 * learned applies here: one vision call, a JSON-schema answer, fail OPEN, and
 * nothing the pipeline READ out of a frame is ever interpolated into a prompt.
 * What does NOT carry over is the question. A digest asks *what happened over
 * this window*; an ordinary rule asks one of three genuinely different things,
 * and which one depends on what the row descends from — see {@link NcRuleAiShape}.
 *
 * ## Why this block is not a field on `NcRule`
 *
 * `NcRule` lives in `@camstack/types`. The addon builds self-contained and
 * INLINES that package, so its own copy is never stale — but the hub's cap
 * router (`notificationRules.createRule` / `updateRule`) validates rule input
 * against the copy `@camstack/system` inlines (`bundleTypesMainEntry`). A new
 * key on `NcRuleInputSchema` is therefore *silently stripped at save* on every
 * hub until a `@camstack/server` release carrying it is installed — the
 * failure `summary/summary-rule.ts` documents and the timelapse rule paid for
 * with three cascaded bugs in one day.
 *
 * So the block is addon-owned: this schema, `rule-ai-store.ts` for the durable
 * side table keyed by rule id, and the `nc.getRuleAi` / `nc.setRuleAi` bridge
 * actions (`addons.custom`, no cap, no codegen, no train). A field added here is
 * live on the next `camstack deploy packages/addon-post-analysis`.
 *
 * It is a side table and not a second opinion: nothing else in this repo stores
 * whether a rule narrates itself, so there is no authority for it to disagree
 * with. Its lifetime is bound to the rule's — `nc.deleteRule` drops the row.
 *
 * ## There is no `onFailure: 'skip'` here, deliberately
 *
 * The digest has one because a digest is a scheduled artefact nobody is waiting
 * for. An ordinary notification is an alarm, and a knob that withholds one
 * because a local model was cold would be a SECOND suppression authority
 * disagreeing with the first: `NcConfirm` already decides whether a
 * notification fires. This block only ever adds a sentence, so its only failure
 * mode is the sentence — counted and logged, never silent.
 */

import { z } from 'zod'
import { ANNOTATED_SCENE_KINDS, CLEAN_SCENE_KINDS } from './rule-engine.js'
import { NcLanguageSchema } from './text-catalog.js'

/**
 * WHICH QUESTION this row's picture is worth asking.
 *
 * Not a rule setting: it is derived from the row, because the operator cannot
 * author a shape that contradicts what the notification is about. Three, and
 * every rule kind reaches one of them:
 *
 * | shape | rows | the question |
 * | --- | --- | --- |
 * | `occupancy` | a committed count edge (`subject.occupancy`) | does the NUMBER this notification claims actually hold? |
 * | `detection-track` | `delivery: 'track-end'` — the track has CLOSED | what HAPPENED over this passage? |
 * | `detection-immediate` | everything else with a picture: an object event, a doorbell's marker, a sound's photograph | what IS there, in this frame? |
 *
 * The detection split is the one the engine already draws and the only one it
 * draws: `immediate` fires on an object-event insert (a movement-state
 * transition or a zone crossing) with whatever frame is in band at that
 * instant, and `track-end` fires from `TrackCloser.closeExpired` with the whole
 * closed track behind it. A track's BIRTH is an `appearanceEvent` and is
 * deliberately off the notification bus, so "the first frame of the track" is
 * not a moment any rule can fire on — the honest reading of `immediate` is
 * "this instant", not "the first frame".
 */
export const NC_RULE_AI_SHAPES = ['occupancy', 'detection-immediate', 'detection-track'] as const
const NcRuleAiShapeSchema = z.enum(NC_RULE_AI_SHAPES)
export type NcRuleAiShape = z.infer<typeof NcRuleAiShapeSchema>

/** The answer's language. The catalog's own enum — a third language is added to
 *  `NC_LANGUAGES` and nowhere else. */
export const NcRuleAiLanguageSchema = NcLanguageSchema
export type NcRuleAiLanguage = z.infer<typeof NcRuleAiLanguageSchema>

// ── The word cap ─────────────────────────────────────────────────────

/**
 * The floor and ceiling on the answer, in WORDS.
 *
 * Words and not lines: a model counts lines badly (it cannot know the width it
 * will be wrapped to) and a notification wraps itself anyway. Words are a unit
 * the model reliably respects and that this file can also ENFORCE afterwards,
 * which a line count could not.
 */
export const NC_RULE_AI_WORDS_MIN = 12
export const NC_RULE_AI_WORDS_MAX = 120

/**
 * The default when the target's own budget is unknown.
 *
 * PUSH-SHAPED on purpose. A sentence too short for a mailbox costs a little
 * detail; one too long for a lock screen is truncated mid-word by the degrade
 * engine, and the operator sees a feature that does not work.
 */
export const NC_RULE_AI_WORDS_FALLBACK = 24

/**
 * Where the default word cap comes from: `TargetKindCaps.bodyMaxLen`.
 *
 * The delivery TARGET decides, and this is the only thing a target kind
 * DECLARES about how much text it can carry — the same number the degrade
 * engine truncates the finished body on. Deriving from it rather than from a
 * hand-written list of service names is what stops the two disagreeing, and
 * what gives a notifier kind added tomorrow a sensible default for free.
 *
 * The curve is logarithmic, not proportional, and both halves of that matter.
 * A proportional share of the budget collapses at the top — every kind from
 * ntfy (4096) upward would hit the same ceiling and the knob would decide
 * nothing — while a straight ratio at the bottom would hand a 500-char target
 * a paragraph. Doubling the budget buys {@link NC_RULE_AI_WORDS_PER_DOUBLING}
 * more words, from a floor of {@link NC_RULE_AI_WORDS_FLOOR_CHARS}:
 *
 * | kind (declared `bodyMaxLen`) | words |
 * | --- | --- |
 * | (legacy 500-char push) | 12 |
 * | pushover (1024) | 24 |
 * | discord (2000) | 36 |
 * | home-assistant (3500) | 46 |
 * | ntfy · gotify · telegram · whatsapp (4096) | 48 |
 * | webhook · zentik (1 000 000) | 120 |
 *
 * Which is the operator's sentence, arrived at from a declared number: a push
 * notification is truncated by the screen and wants few words; a webhook or a
 * mailbox can take many.
 */
export const NC_RULE_AI_WORDS_FLOOR_CHARS = 250
export const NC_RULE_AI_WORDS_PER_DOUBLING = 12

/**
 * The word cap for ONE delivery: the rule's own number when the operator wrote
 * one, otherwise derived from the target.
 *
 * `bodyMaxLen` absent — an older provider, a kind catalog that did not answer —
 * is UNKNOWN, never zero: it falls back to {@link NC_RULE_AI_WORDS_FALLBACK}
 * rather than to a cap of nothing.
 */
export function ruleAiWordCap(
  authored: number | undefined,
  bodyMaxLen: number | undefined,
): number {
  if (authored !== undefined) return authored
  if (bodyMaxLen === undefined || !Number.isFinite(bodyMaxLen) || bodyMaxLen <= 0) {
    return NC_RULE_AI_WORDS_FALLBACK
  }
  const doublings = Math.log2(bodyMaxLen / NC_RULE_AI_WORDS_FLOOR_CHARS)
  const words = Math.round(NC_RULE_AI_WORDS_PER_DOUBLING * doublings)
  return Math.min(NC_RULE_AI_WORDS_MAX, Math.max(NC_RULE_AI_WORDS_MIN, words))
}

// ── The rule block ───────────────────────────────────────────────────

/**
 * How many frames a TRACK-CLOSE answer may look at.
 *
 * Three: the passage's beginning, its best-seen moment and its end. More is
 * minutes of local vision work for a notification somebody is holding a phone
 * for, and fewer cannot answer "what happened" — two frames is a before and an
 * after with nothing between them.
 */
export const NC_RULE_AI_TRACK_FRAMES = 3

/** 448 px is the native tile size of these vision encoders — see `downscaleJpeg`. */
export const NC_RULE_AI_FALLBACK_MAX_IMAGE_PX = 448

/**
 * The bound when the rule froze none — and it is the CONFIRM gate's, not the
 * digest's.
 *
 * A person is holding a phone. The digest may take three minutes because its
 * window has closed and nobody is waiting; here the sentence arrives with the
 * notification or it is not worth having.
 */
export const NC_RULE_AI_FALLBACK_TIMEOUT_MS = 8_000

const NC_RULE_AI_MIN_TIMEOUT_MS = 1_000
const NC_RULE_AI_MAX_TIMEOUT_MS = 30_000

/**
 * The operator's AI section for one ordinary rule.
 *
 * No `.default()` anywhere: this block travels to the dispatcher FROZEN on a
 * durable outbox row, and a default materialised at parse time would be a
 * number the operator never chose, pinned onto a row for days.
 */
export const NcRuleAiSchema = z.object({
  enabled: z.boolean(),
  profileId: z.string().optional(),
  /**
   * The operator's own question, replacing the shape's default one. NEVER
   * composed with text READ FROM A FRAME — D121: a model reads OSD, plates and
   * signs as instructions.
   *
   * It replaces the QUESTION and never the contract: the answer schema and the
   * hardening clauses live in the system turn, where nothing authorable
   * reaches them.
   */
  prompt: z.string().max(2_000).optional(),
  /** Absent = the rule owner's language, i.e. the language this hub's texts are
   *  served in. Per RULE and never per recipient — a per-recipient language
   *  would mean one generation per language for one notification. */
  language: NcRuleAiLanguageSchema.optional(),
  /** Absent = derived from the delivery target — see {@link ruleAiWordCap}. */
  maxWords: z.number().int().min(NC_RULE_AI_WORDS_MIN).max(NC_RULE_AI_WORDS_MAX).optional(),
  maxImagePx: z.number().int().min(64).max(2_048).optional(),
  /** An EXTERNAL race, not the HTTP timeout — that one is `profile.timeoutMs`
   *  and this can never lengthen it. */
  timeoutMs: z
    .number()
    .int()
    .min(NC_RULE_AI_MIN_TIMEOUT_MS)
    .max(NC_RULE_AI_MAX_TIMEOUT_MS)
    .optional(),
})
export type NcRuleAi = z.infer<typeof NcRuleAiSchema>

// ── What a TRACK-CLOSE pass looks at ─────────────────────────────────

/** One media index row, as the frame picker needs to see it (never the bytes). */
export interface NcRuleAiMediaRow {
  readonly mediaId: number
  readonly kind: string
  readonly timestamp: number
}

/**
 * The kinds a "what happened" question may be answered from: WHOLE SCENES,
 * clean or annotated, and never a crop.
 *
 * Composed from the two lists `rule-engine.ts` already owns rather than a
 * fourth copy of them — the failure mode of a drifted media-kind list here is
 * silent (a passage narrated from three crops of the same face).
 *
 * The ANNOTATED tiles are deliberately included, which is the opposite of the
 * digest's choice, and the difference is what the picture is FOR: a burnt-in
 * box in a mosaic tile is a permanent claim the operator re-reads days later,
 * while here it is one input to a sentence and nothing is stored. It matters
 * because they are the only DENSELY written whole-scene kinds — the clean
 * `keyFrame` family is `putReplacing`, one instant per track, so a clean-only
 * rule would give the model one frame and no passage at all.
 */
export const NC_RULE_AI_TRACK_FRAME_KINDS: ReadonlySet<string> = new Set([
  ...CLEAN_SCENE_KINDS,
  ...ANNOTATED_SCENE_KINDS,
])

/**
 * The frames a TRACK-CLOSE answer is built from: the passage SPANNED, oldest
 * first.
 *
 * Evenly spaced and always including the first and the last row, because the
 * question is what happened between them. Taking the newest `max` would answer
 * "what is there" with more pictures — which is the immediate shape's question
 * and the exact collapse the three shapes exist to prevent.
 *
 * A track with no whole-scene row at all falls back to whatever it has rather
 * than to nothing: one crop is a worse input than three scenes and a better one
 * than no pass.
 */
export function pickTrackNarrationFrames<TRow extends NcRuleAiMediaRow>(
  rows: readonly TRow[],
  max: number,
): readonly TRow[] {
  if (max <= 0) return []
  const scenes = rows.filter((row) => NC_RULE_AI_TRACK_FRAME_KINDS.has(row.kind))
  const pool = scenes.length > 0 ? scenes : rows
  const seen = new Set<number>()
  const ordered = pool
    .filter((row) => (seen.has(row.mediaId) ? false : (seen.add(row.mediaId), true)))
    .toSorted((a, b) => a.timestamp - b.timestamp)
  if (ordered.length <= max) return ordered
  const picked: TRow[] = []
  for (let i = 0; i < max; i += 1) {
    const row = ordered[Math.round((i * (ordered.length - 1)) / (max - 1))]
    if (row !== undefined && !picked.includes(row)) picked.push(row)
  }
  return picked
}

// The DERIVATION of the frozen policy lives in `rule-ai-policy.ts`, beside
// `confirm-policy.ts` and for the same reason: it needs the outbox shapes, and
// keeping it out of here is what stops the two modules importing each other.
