/**
 * TimelapseRule — the STANDALONE scheduled timelapse producer's rule model.
 *
 * Spec: `docs/superpowers/specs/2026-07-24-nc-occupancy-timelapse-design.md`
 * §3.2/§3.3.
 *
 * Deliberately NOT a capability definition and NOT an `NcRule`:
 *  - Every `NcDelivery` member is a *persisted-pipeline-record* trigger. A
 *    timelapse fires on a SCHEDULE WINDOW BOUNDARY, evaluates no pipeline
 *    record, and produces a video it assembled itself — so it rides no
 *    delivery-enum member (the enum is frozen) and no cap method. This file is
 *    a plain typed schema; it does NOT go through `npm run codegen`.
 *  - It shares only the delivery leg (`notification-output.send`) and the
 *    persistence/ownership patterns with the Notification Center, reusing
 *    {@link NcScheduleSchema} (weekly windows, midnight-crossing, invertible)
 *    and {@link NcRuleTargetSchema} (target ref + passthrough params).
 *
 * Ownership is SERVER-DERIVED. `ownerUserId` / `createdBy` / `createdAt` /
 * `updatedAt` / `id` / `lastGeneratedAt` live on the PERSISTED rule only —
 * {@link TimelapseRuleInputSchema} and {@link TimelapseRulePatchSchema} do not
 * carry them, so a forged client payload can never claim or re-own a rule
 * (Zod strips unknown keys). The store stamps them from the resolved caller.
 */

import { z } from 'zod'
import { NcRuleTargetSchema, NcScheduleSchema } from '../capabilities/notification-rules.cap.js'

/** `{{var}}` templating over camera/rule/time — same vocabulary as `NcRule`. */
export const TimelapseTemplateSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(2000).optional(),
})
export type TimelapseTemplate = z.infer<typeof TimelapseTemplateSchema>

// ── Field constraints (declared ONCE, shared by input + patch) ──────
// The patch schema is NOT `Input.partial()`: in Zod 4 `.partial()` keeps the
// inner `.default()`, so parsing `{ name }` would silently materialise
// `enabled/cadenceSec/framerate/priority` and RESET those fields on update.
// The patch therefore re-uses the constraint schemas with `.optional()` and no
// defaults; `timelapse-rule.spec.ts` asserts the two key sets stay in sync.
const NameField = z.string().min(1).max(200)
const DeviceIdsField = z.array(z.number()).min(1)
const CadenceSecField = z.number().int().min(2).max(3600)
const FramerateField = z.number().int().min(1).max(60)
const TargetsField = z.array(NcRuleTargetSchema).min(1)
const PriorityField = z.number().int().min(1).max(5)

/**
 * Floor on any dense cadence, seconds — the recording's own frame interval.
 *
 * Declared here because it bounds BOTH the rule field and the renderer's
 * derivation, and two copies of a floor are two floors that can drift.
 */
export const TIMELAPSE_DENSE_FLOOR_SEC = 0.1

/**
 * Explicit override of the DENSE sampling cadence, seconds.
 *
 * Absent ⇒ derived as `max(1s, cadenceSec / 30)` — a 30 s base samples every
 * 1 s inside a detection range. (It was `base / 10` until 2026-08-12, which
 * made that same base 3 s and rendered a person pass as two frames.)
 *
 * THE ARITHMETIC. A detection range of `rangeSec` seconds sampled every
 * `denseCadenceSec` and played at `framerate` occupies
 *
 *     outputSeconds = (rangeSec / denseCadenceSec) / framerate
 *
 * so a 7 s pass at 1 s / 12 fps is 0.58 s of video, and at 0.5 s it is 1.17 s.
 * Halving this field doubles the frames INSIDE ranges only — the base cadence,
 * and therefore the length of a quiet night, does not move.
 *
 * Floored at {@link TIMELAPSE_DENSE_FLOOR_SEC}: asking for frames faster than
 * the recording has them returns the same frames, requested twice. Must be
 * STRICTLY smaller than `cadenceSec` — a dense rate that is not denser renders
 * a uniform video the operator believes is two-rate — and upsert refuses it
 * rather than letting the export cap reject the render hours after the window.
 */
const DenseCadenceSecField = z.number().min(TIMELAPSE_DENSE_FLOOR_SEC).max(3600)

/**
 * Minimum seconds of OUTPUT video each detection range must occupy.
 *
 * The operator-facing form of the arithmetic above: instead of solving for a
 * cadence, state the dwell and let the renderer solve. `minDwellSec: 1` on a
 * 30 s base at 12 fps turns a 7 s pass into a full second of video by sampling
 * that range every ~583 ms.
 *
 * ONE CADENCE SERVES EVERY RANGE. `ExportDenseSchema.everyMs` is global — the
 * ranges are terms of a single ffmpeg `select` expression that cannot vary rate
 * per term — so the MOST DEMANDING (shortest) range sets the rate and longer
 * ranges are sampled denser than they need. Per-range cadences require a cap
 * schema change and are the tracked follow-up.
 *
 * A range too short to reach the dwell even at {@link TIMELAPSE_DENSE_FLOOR_SEC}
 * is rendered with every frame that EXISTS and no more: the guarantee is capped
 * by real footage, never met by duplicating frames into motion that never
 * happened.
 */
const MinDwellSecField = z.number().min(0).max(60)
/**
 * Caption burned into the notification's preview frame.
 *
 * Same `{{var}}` vocabulary as {@link TimelapseTemplateSchema} (`camera`,
 * `rule`, `from`, `to`) and rendered by the SAME renderer — a second
 * templating dialect for one field would be a second thing to explain.
 *
 * Absent ⇒ {@link DEFAULT_TIMELAPSE_PREVIEW_TEXT}. An EMPTY STRING is the
 * operator saying "the frame, no caption" — a distinct, reachable answer, and
 * the reason this is not `.min(1)`.
 */
const PreviewTextField = z.string().max(200)
/**
 * Whether the notification's preview is a STILL or a short animation.
 *
 * The operator's ask, verbatim: *"inviato come gif o video (come per le altre
 * rule)"* [sent as a gif or video (as for the other rules)] — the other rules already offer an animated preview, and a ten-hour
 * night reads better as three seconds of motion than as one frame of it. Both
 * modes get the SAME treatment (blurred frame, large centred title); `'gif'`
 * simply applies it to a dozen frames sampled across the render and assembles
 * them.
 *
 * `'image'` is the default and stays the default: a GIF costs a dozen ffmpeg
 * seeks and a palette pass, and no rule that never asked for one should start
 * paying that on the deploy that shipped it.
 *
 * A GIF that cannot be assembled DEGRADES to the still — never to nothing.
 */
const PreviewModeField = z.enum(['image', 'gif'])
/** Still or animation — the rule field, as a type the renderer can take. */
export type TimelapsePreviewMode = z.infer<typeof PreviewModeField>
/**
 * Which detection classes the notification reports counts for.
 *
 * The counts come from the tracks the render ALREADY fetched for its dense-range
 * plan — no second query — aggregated per class. Absent or empty means "every
 * class the window actually contained", which is what an operator who never
 * opened the field wants; a list narrows it (`['person']` on a driveway that
 * counts cars all night).
 *
 * Class names are the tracker's own (`person`, `vehicle`, `animal`, `package`,
 * …). An unknown name simply never matches and reports nothing — it is not an
 * error, because a rule may legitimately name a class this camera's model does
 * not emit.
 *
 * The counts are exposed to {@link TimelapseTemplateSchema} as:
 *  - `{{detections}}` — total over the reported classes
 *  - `{{detectionSummary}}` — `2 persone, 1 veicolo`
 *  - `{{count_person}}` / `{{count_vehicle}}` / `{{count_animal}}` / … —
 *    one per class, `count_` + the class name
 *
 * With NO custom body template the summary is appended to the derived body, and
 * only when the total is non-zero: a nightly `0 rilevamenti` is a line nobody
 * reads. With a custom template the operator owns every word — nothing is
 * appended, so `{{detectionSummary}}` is how he asks for it.
 */
const ReportClassesField = z.array(z.string().min(1).max(40)).max(20)

/**
 * Client-supplied timelapse-rule fields. The server stamps id / createdBy /
 * createdAt / updatedAt / ownerUserId / lastGeneratedAt — none of them appear
 * here (see the ownership note above).
 */
export const TimelapseRuleInputSchema = z.object({
  name: NameField,
  enabled: z.boolean().default(true),
  /** Cameras sampled by this rule — one scratch dir + one artifact per device. */
  deviceIds: DeviceIdsField,
  /**
   * Activation window(s). REQUIRED (unlike `NcRule`, where an absent schedule
   * means "always active"): a timelapse is defined by its window boundaries —
   * open clears the scratch, close assembles and delivers.
   */
  schedule: NcScheduleSchema,
  /** Force-snapshot cadence inside the window, seconds (predecessor parity). */
  cadenceSec: CadenceSecField.default(15),
  /** Output frames per second of the assembled mp4 (predecessor parity). */
  framerate: FramerateField.default(10),
  /**
   * Explicit dense cadence — see {@link DenseCadenceSecField}. Absent ⇒ derived
   * as `max(1s, cadenceSec / 30)`, which is what every rule written before this
   * field gets.
   */
  denseCadenceSec: DenseCadenceSecField.optional(),
  /** Output-seconds guarantee per detection range — see {@link MinDwellSecField}. */
  minDwellSec: MinDwellSecField.optional(),
  /** `notification-output` targets the finished video/thumbnail is sent to. */
  targets: TargetsField,
  template: TimelapseTemplateSchema.optional(),
  /**
   * Caption on the notification's PREVIEW FRAME — see {@link PreviewTextField}
   * and {@link DEFAULT_TIMELAPSE_PREVIEW_TEXT}.
   *
   * Deliberately NOT part of {@link TimelapseTemplateSchema}: that object is
   * the notification's title/body, and clearing it (`template: null`) must not
   * silently clear the caption too.
   */
  previewText: PreviewTextField.optional(),
  /** Still or animation — see {@link PreviewModeField}. */
  previewMode: PreviewModeField.default('image'),
  /** Classes the notification counts — see {@link ReportClassesField}. */
  reportClasses: ReportClassesField.optional(),
  /** Canonical notification priority ordinal (1..5); per-target overridable. */
  priority: PriorityField.default(3),
})
export type TimelapseRuleInput = z.infer<typeof TimelapseRuleInputSchema>

/**
 * The caption a rule that never set one gets.
 *
 * Rendered through the ordinary `{{var}}` pass at delivery, so a rule created
 * before this field existed still reads "Timelapse Camera front door" and
 * not the literal braces.
 */
export const DEFAULT_TIMELAPSE_PREVIEW_TEXT = 'Timelapse {{camera}}'

/**
 * Partial patch for an update — any subset of the INPUT fields, with NO
 * defaults (an absent key means "leave unchanged", never "reset to default").
 * Provenance and ownership are absent by construction: a patch can rename or
 * retune a rule, never re-own it or forge its generation state.
 *
 * CLEAR SIGNAL: `template` is the one OPTIONAL field an editor can REMOVE, so
 * it is `.nullable()` here and NOWHERE else. Wire representation:
 *  - key absent          → leave the template unchanged
 *  - `"template": null`  → CLEAR it (the persisted rule loses the key)
 *  - `"template": {...}` → replace it
 * `undefined` is deliberately NOT the clear signal: it does not survive
 * `JSON.stringify`, so a viewer editor could not express "remove". The
 * PERSISTED rule never carries `null` — the store drops the key (see
 * `TimelapseStore.update`).
 */
export const TimelapseRulePatchSchema = z.object({
  name: NameField.optional(),
  enabled: z.boolean().optional(),
  deviceIds: DeviceIdsField.optional(),
  schedule: NcScheduleSchema.optional(),
  cadenceSec: CadenceSecField.optional(),
  framerate: FramerateField.optional(),
  denseCadenceSec: DenseCadenceSecField.optional(),
  minDwellSec: MinDwellSecField.optional(),
  targets: TargetsField.optional(),
  template: TimelapseTemplateSchema.nullable().optional(),
  previewText: PreviewTextField.optional(),
  previewMode: PreviewModeField.optional(),
  reportClasses: ReportClassesField.optional(),
  priority: PriorityField.optional(),
})
export type TimelapseRulePatch = z.infer<typeof TimelapseRulePatchSchema>

/** A persisted timelapse rule. */
export const TimelapseRuleSchema = TimelapseRuleInputSchema.extend({
  id: z.string(),
  /**
   * Ownership/visibility key. Absent = admin/global rule (visible to all).
   * Present = personal rule owned by this userId. Server-stamped from the
   * resolved caller; never trusted from a client payload.
   */
  ownerUserId: z.string().optional(),
  /**
   * Epoch-ms of the NEWEST successful generation across every camera of this
   * rule. What a UI shows, and the compatibility floor for
   * {@link readTimelapseGeneratedAt}. Absent = never generated.
   */
  lastGeneratedAt: z.number().optional(),
  /**
   * PER-CAMERA generation state, keyed by `String(deviceId)` — the
   * re-generation guard's real durable state.
   *
   * One rule covers several cameras and each renders its own video, so a rule
   * -wide stamp is wrong in the direction that DESTROYS work: camera A
   * succeeding at 06:05 tells camera B, whose render failed, that it is
   * already done — and B's night is gone for good, because the window will not
   * come back.
   *
   * ADDITIVE, so the migration is free: a row written before this field simply
   * has no map, and {@link readTimelapseGeneratedAt} falls back to
   * {@link TimelapseRuleSchema.shape.lastGeneratedAt}. Reading an old row as
   * "never generated" would re-render and re-notify every camera of every rule
   * once, on the deploy that shipped the map.
   */
  generatedByDevice: z.record(z.string(), z.number()).optional(),
  /** userId of the caller who created the rule (server-stamped). */
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type TimelapseRule = z.infer<typeof TimelapseRuleSchema>

/** The cadence pair a rule must satisfy — the guard's whole input. */
export interface TimelapseCadencePair {
  readonly cadenceSec: number
  readonly denseCadenceSec?: number
}

/**
 * Refuse a dense cadence that is not denser than the base.
 *
 * Called at UPSERT, on the MERGED rule — a patch that lowers `cadenceSec`
 * alone can invalidate a `denseCadenceSec` set months earlier, so checking the
 * patch in isolation would let the bad pair through.
 *
 * Refusing here and not at render time is the whole point: `ExportTimelapseSchema`
 * also rejects the pair, but it does so when the window has already closed and
 * the footage is being cut — the operator learns at 06:05 that last night was
 * never going to render, and a closed window does not come back. This turns
 * that into a failed edit he can see and correct.
 *
 * @throws Error naming both numbers, so the message is actionable in a toast.
 */
export function assertTimelapseCadences(pair: TimelapseCadencePair): void {
  const dense = pair.denseCadenceSec
  if (dense === undefined) return
  if (dense >= pair.cadenceSec) {
    throw new Error(
      `denseCadenceSec (${dense}s) must be strictly smaller than cadenceSec (${pair.cadenceSec}s) — ` +
        'a dense cadence that is not denser renders a uniform timelapse',
    )
  }
}

/**
 * The last successful generation for ONE camera of a rule, epoch-ms.
 *
 * The per-device map wins; a rule with no map falls back to the rule-wide
 * `lastGeneratedAt` (the compatible-migration path — see
 * {@link TimelapseRuleSchema}); a rule with neither returns 0, which every
 * guard reads as "never generated".
 *
 * Read through this helper and never off the field directly: the fallback is
 * the whole migration, and a call site that forgot it would re-render an
 * entire rule set once.
 */
export function readTimelapseGeneratedAt(
  rule: Pick<TimelapseRule, 'lastGeneratedAt' | 'generatedByDevice'>,
  deviceId: number,
): number {
  // The presence of the MAP is the migration signal, not the presence of this
  // device's key in it. Once a rule has a map, a camera missing from it has
  // genuinely never generated — falling back to the rule-wide stamp there
  // would tell every un-rendered camera it was already done the moment the
  // first one succeeded, which is the exact defect the map exists to fix.
  const map = rule.generatedByDevice
  if (map !== undefined) return map[String(deviceId)] ?? 0
  return rule.lastGeneratedAt ?? 0
}
