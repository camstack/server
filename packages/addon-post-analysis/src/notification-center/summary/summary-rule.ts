/**
 * NcSummaryRule — the MULTI-CAMERA digest rule.
 *
 * One rule, N cameras, ONE artefact per window: a clean mosaic of the best shot
 * of every track the window contained, delivered through the ordinary outbox.
 * That is the whole of P1. The `ai` section below is READ by
 * `summary/summary-ai.ts` (P2, landed): the producer hands the frames the
 * mosaic was built from to one joint `llm.generateVision` call and the delivery
 * puts the answer in the body as `{{ai}}`. Because the section is `.optional()`
 * and the pass fails OPEN, a rule that does not carry one delivers
 * byte-for-byte as it did in P1.
 *
 * ## Why this schema lives in the ADDON and not in `packages/types`
 *
 * `@camstack/types` is `external` in every mode of the build preset, so the
 * addon resolves it at runtime from the `@camstack/server` closure. A field
 * added there is not live until a framework train is published AND installed —
 * and worse, a NEW field on a cap-validated shape is *silently stripped* at save
 * until that train lands. The timelapse rule paid that price with three cascaded
 * bugs in one day.
 *
 * This rule rides no `NcDelivery` member, no cap method and no codegen. It
 * reaches the outside world through the `nc.*SummaryRule*` bridge actions
 * (`addons.custom`), exactly like `NcTestEventInputSchema` does — so a field
 * added here is live on the next `camstack deploy packages/addon-post-analysis`.
 * Promotion into `packages/types` later is additive and needs no migration.
 *
 * ## The `.partial()` trap this file exists to avoid
 *
 * Found in production 2026-08-12: `NcRulePatchSchema` was
 * `NcRuleInputSchema.partial()`, and Zod 4 `.partial()` KEEPS the inner
 * `.default()`. Parsing `{ name: 'x' }` therefore materialised every defaulted
 * key, and `{ ...existing, ...patch }` wrote them over the rule — a camera- and
 * zone-scoped rule silently became a rule that matched everything.
 *
 * So: every constraint is declared ONCE below; `.default()` appears ONLY in the
 * Input schema and `.optional()` ONLY in the hand-written Patch. `summary-rule.spec.ts`
 * asserts the two key sets stay identical AND that a one-key patch parses to
 * exactly one key.
 */

import { NcRuleTargetSchema, NcScheduleSchema } from '@camstack/types'
import { z } from 'zod'

/** `{{var}}` templating — the same vocabulary the timelapse and rule bodies use. */
export const NcSummaryTemplateSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(2000).optional(),
})
export type NcSummaryTemplate = z.infer<typeof NcSummaryTemplateSchema>

// ── Field constraints, declared ONCE ─────────────────────────────────

const NameField = z.string().min(1).max(200)
/** MULTI-CAMERA is the point of the feature — a one-camera digest is a
 *  timelapse with extra steps, but it is allowed and it is cheap. */
const DeviceIdsField = z.array(z.number()).min(1).max(64)
const TargetsField = z.array(NcRuleTargetSchema).min(1)
const PriorityField = z.number().int().min(1).max(5)

/**
 * The mosaic's tile ceiling. 9 (a 3×3 grid) is the shipped default: it is the
 * most a phone lock-screen thumbnail can carry and still be read, and it is the
 * number the operator approved.
 */
const NC_SUMMARY_MAX_TILES = 24
export const NC_SUMMARY_DEFAULT_TILES = 12

/**
 * How many tiles the (future) model may look at. Separate from the tile budget
 * on purpose: one is bounded by pixels, the other by the profile's 60 s HTTP
 * timeout. Binding them means always choosing the worse of the two.
 */
const NC_SUMMARY_MAX_AI_IMAGES = 8
const NC_SUMMARY_DEFAULT_AI_IMAGES = 6

const MaxTilesField = z.number().int().min(1).max(NC_SUMMARY_MAX_TILES)
const MaxAiImagesField = z.number().int().min(1).max(NC_SUMMARY_MAX_AI_IMAGES)

/**
 * The MOTION window's quiet period, seconds.
 *
 * The window opens on the first motion seen on ANY of the rule's cameras and
 * stays open while motion keeps arriving. `quietSeconds` with nothing new on
 * any of them is what closes it — the operator's "windows driven by MOTION of
 * the selected cameras".
 */
const QuietSecondsField = z.number().int().min(30).max(3600)

/**
 * The hard ceiling on ONE motion window, seconds.
 *
 * The operator's "max-wait bounded by the camera with the widest window": a
 * continuously busy driveway would otherwise keep a window open forever and the
 * digest would never be delivered. When this bites, the window closes with
 * whatever it holds and SAYS so on the log line.
 */
const MaxWindowSecondsField = z.number().int().min(60).max(86_400)

/**
 * How long the producer waits for the window's own tracks to CLOSE before it
 * analyses anything — the operator's track-close barrier, in seconds.
 *
 * A track's best shot (`keyFrameSmall` / `thumbnail`) is written when the track
 * CLOSES. Rendering the instant the window ends therefore renders exactly the
 * subjects that were still moving — the ones the digest is most about — with no
 * picture at all. The barrier waits for every track the window opened to close,
 * and is itself bounded: at the bound the window renders with the tracks it has
 * and logs the ones it gave up on.
 */
const BarrierSecondsField = z.number().int().min(0).max(3600)

/**
 * How the window is defined. A discriminated union, because two optional
 * fields would make "neither" and "both" representable and both would have to
 * be refused by hand.
 */
export const NcSummaryWindowSchema = z.discriminatedUnion('kind', [
  /**
   * Fixed-time digest: the window IS an `NcSchedule` (weekly bands, midnight
   * crossing, IANA timezone, invertible). It closes when the schedule closes.
   */
  z.object({ kind: z.literal('schedule'), schedule: NcScheduleSchema }),
  /**
   * Rolling MOTION window: opened by motion on any of the rule's cameras,
   * extended by further motion, closed by `quietSeconds` of nothing — and hard
   * closed at `maxWindowSeconds` regardless.
   */
  z.object({
    kind: z.literal('motion'),
    quietSeconds: QuietSecondsField,
    maxWindowSeconds: MaxWindowSecondsField,
  }),
])
export type NcSummaryWindow = z.infer<typeof NcSummaryWindowSchema>

/**
 * What enters the window. Evaluated on TRACKS, never on object events: one
 * track is one passage is one tile, and `importance` / dwell only exist at
 * track level (the same reason `NcRule` offers them only on `track-end`).
 *
 * `zones` is a FLAT id list and is scoped PER CAMERA by
 * `zone-ownership.ts#scopeZoneIdsToDevice` — picking a zone on camera A must
 * not silently mute camera B, which is the defect that helper exists for.
 */
export const NcSummaryFiltersSchema = z.object({
  classes: z.array(z.string().min(1).max(40)).max(20).optional(),
  classesExclude: z.array(z.string().min(1).max(40)).max(20).optional(),
  zones: z.array(z.string()).max(40).optional(),
  minImportance: z.number().min(0).max(1).optional(),
  minDwellSeconds: z.number().min(0).max(3600).optional(),
  /**
   * Put PARKED objects in the digest too. Off unless explicitly turned on, and
   * an ABSENT field reads as off — the soft migration, no backfill.
   *
   * A digest is a record of PASSAGES: the operator's words are "the last
   * summaries still include an enormous number of stationary tracks". Since
   * D161 a track promoted to the stationary registry is persisted rather than
   * dropped (it owns media the retention sweep has to reach), so the car parked
   * in front of camera 102 now enters every window it overlaps and, ranked on
   * importance and dwell, wins tiles from the passages the digest is about. The
   * measured effect on the live hub was 1-2 tiles becoming 10.
   *
   * `.optional()` and NOT `.default(false)`: a `.default()` here would be
   * materialised by `NcSummaryRulePatchSchema` on any patch that named
   * `filters`, which is the `.partial()` trap this module's docblock describes.
   * `filterSummaryCandidates` reads `=== true`, so absent and false are the
   * same answer and neither needs a stored value.
   */
  includeStationary: z.boolean().optional(),
})
export type NcSummaryFilters = z.infer<typeof NcSummaryFiltersSchema>

/**
 * How tiles are chosen when the window holds more tracks than the budget.
 *
 * `importance` is the pipeline's own deterministic score and the default. The
 * per-camera quota that guarantees every contributing camera at least one tile
 * is NOT a rank — it applies to all of them, because a multi-camera digest in
 * which two of six cameras never appear is not multi-camera.
 */
export const NcSummaryRankSchema = z.enum(['importance', 'recency', 'dwell'])
export type NcSummaryRank = z.infer<typeof NcSummaryRankSchema>

/**
 * How much TEXT is burnt into the mosaic — and the answer is NONE by default.
 *
 * `none` is the shipped default and, crucially, the reading of an ABSENT field:
 * `.default()` on the Input schema materialises it, and the persisted schema
 * extends Input, so a rule authored before this option existed parses as `none`
 * on the next read. No migration, no backfill, no rewrite of a stored rule.
 *
 * The operator asked for "solo immagini". Three reasons it is the right
 * default rather than a preference:
 *
 *  - a caption is PERMANENT in the artefact, exactly like a detection box, and
 *    a mosaic is re-read days later;
 *  - the per-tile strip covers 14% of the tile from the bottom edge up, which
 *    is where feet, wheels and parcels are;
 *  - nothing downstream needs it. The AI pass is given the RAW per-track JPEGs
 *    and gets camera, class and time as PROMPT TEXT — it never reads the
 *    mosaic, so the pixels carry no fact the judge would lose.
 *
 * `tiles` and `all` keep the old behaviour reachable for an operator who wants
 * it; `all` is byte-for-byte what every rule produced before this field.
 */
export const NcSummaryCaptionsSchema = z.enum(['none', 'tiles', 'all'])
export type NcSummaryCaptions = z.infer<typeof NcSummaryCaptionsSchema>
const NC_SUMMARY_DEFAULT_CAPTIONS: NcSummaryCaptions = 'none'

/**
 * The AI section — read by `NcSummaryAiAnalyst.analyse`.
 *
 * `.optional()` so an absent section is the ordinary case rather than a
 * migration, and the analyst fails OPEN, so a rule that carries one still
 * delivers its mosaic and its counts when the model says nothing.
 *
 * The ORDINARY rules have their own AI section, and a deliberately different
 * one: `notification-center/rule-ai.ts`. It asks one of three questions chosen
 * by what the row descends from, and it carries a WORD CAP because a
 * notification is read on a lock screen where a digest is not. Nothing is
 * shared but the vision seam underneath both.
 *
 * No `.default()` anywhere inside it, for the reason in the module docblock.
 */
export const NcSummaryAiSchema = z.object({
  enabled: z.boolean(),
  profileId: z.string().optional(),
  /** The operator's own question. NEVER composed with text READ FROM A FRAME —
   *  D121: a model reads OSD, plates and signs as instructions. */
  prompt: z.string().max(2_000).optional(),
  language: z.enum(['en', 'it']).optional(),
  maxImagePx: z.number().int().min(64).max(2_048).optional(),
  /** An EXTERNAL race, not the HTTP timeout — that one is `profile.timeoutMs`
   *  and this can never lengthen it. */
  timeoutMs: z.number().int().min(10_000).max(600_000).optional(),
  onFailure: z.enum(['deliver-without-text', 'skip']).optional(),
})
export type NcSummaryAi = z.infer<typeof NcSummaryAiSchema>

// ── Input ────────────────────────────────────────────────────────────

export const NcSummaryRuleInputSchema = z.object({
  name: NameField,
  enabled: z.boolean().default(true),
  deviceIds: DeviceIdsField,
  window: NcSummaryWindowSchema,
  filters: NcSummaryFiltersSchema.optional(),
  maxTiles: MaxTilesField.default(NC_SUMMARY_DEFAULT_TILES),
  maxAiImages: MaxAiImagesField.default(NC_SUMMARY_DEFAULT_AI_IMAGES),
  rank: NcSummaryRankSchema.default('importance'),
  barrierSeconds: BarrierSecondsField.default(120),
  targets: TargetsField,
  template: NcSummaryTemplateSchema.optional(),
  /** Burned onto the mosaic's title band — and ONLY when `captions` is `all`. */
  captions: NcSummaryCaptionsSchema.default(NC_SUMMARY_DEFAULT_CAPTIONS),
  /** Burned onto the mosaic's title band. `''` is reachable and means "no
   *  caption" — which is why this is not `.min(1)`. */
  captionText: z.string().max(200).optional(),
  /** Deliver a window that matched NOTHING? Default no: a nightly "0 events"
   *  is a line nobody reads, and it costs the lines beside it their reader. */
  deliverEmpty: z.boolean().default(false),
  priority: PriorityField.default(3),
  ai: NcSummaryAiSchema.optional(),
})
export type NcSummaryRuleInput = z.infer<typeof NcSummaryRuleInputSchema>

// ── Patch — hand-written, no defaults, EVER ──────────────────────────

/**
 * The partial update. NOT `Input.partial()` (see the module docblock).
 *
 * `template` and `ai` are the two CLEARABLE fields: an absent key leaves them
 * alone, an explicit `null` removes them, an object replaces them. Keeping
 * `null` out of the persisted rule is what lets the persisted schema stay a
 * plain `.optional()`.
 */
export const NcSummaryRulePatchSchema = z.object({
  name: NameField.optional(),
  enabled: z.boolean().optional(),
  deviceIds: DeviceIdsField.optional(),
  window: NcSummaryWindowSchema.optional(),
  filters: NcSummaryFiltersSchema.nullable().optional(),
  maxTiles: MaxTilesField.optional(),
  maxAiImages: MaxAiImagesField.optional(),
  rank: NcSummaryRankSchema.optional(),
  barrierSeconds: BarrierSecondsField.optional(),
  targets: TargetsField.optional(),
  template: NcSummaryTemplateSchema.nullable().optional(),
  captions: NcSummaryCaptionsSchema.optional(),
  captionText: z.string().max(200).optional(),
  deliverEmpty: z.boolean().optional(),
  priority: PriorityField.optional(),
  ai: NcSummaryAiSchema.nullable().optional(),
})
export type NcSummaryRulePatch = z.infer<typeof NcSummaryRulePatchSchema>

// ── Persisted ────────────────────────────────────────────────────────

/**
 * The stored rule. Identity, ownership, provenance and the generation stamp are
 * SERVER-STAMPED and appear on neither Input nor Patch, so a forged blob can
 * never claim or re-own a rule (Zod strips unknown keys).
 *
 * `generatedAt` is PER-RULE and not per-camera — unlike the timelapse. One
 * window produces exactly ONE artefact spanning every camera, so there is no
 * per-camera output a shared stamp could destroy.
 */
export const NcSummaryRuleSchema = NcSummaryRuleInputSchema.extend({
  id: z.string(),
  ownerUserId: z.string().optional(),
  /** Epoch-ms of the END of the last window successfully delivered. */
  generatedAt: z.number().optional(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type NcSummaryRule = z.infer<typeof NcSummaryRuleSchema>

/**
 * The one cross-field invariant, checked on the MERGED rule at upsert (never on
 * the patch alone — lowering `maxTiles` by itself can invalidate a `maxAiImages`
 * set weeks earlier, and checking the patch in isolation persists that pair).
 *
 * Failing at SAVE time is the whole point: the alternative is discovering it at
 * 07:05 when the window has already closed and cannot come back.
 */
export function assertSummaryBudget(rule: {
  readonly maxTiles: number
  readonly maxAiImages: number
}): void {
  if (rule.maxAiImages > rule.maxTiles) {
    throw new Error(
      `maxAiImages (${rule.maxAiImages}) cannot exceed maxTiles (${rule.maxTiles}) — ` +
        'the model cannot judge frames the mosaic does not contain',
    )
  }
}
