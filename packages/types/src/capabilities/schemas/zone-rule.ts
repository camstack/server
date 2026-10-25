import { z } from 'zod'

/**
 * Per-stage gating mode applied to the zones a rule references.
 *
 * - `include`: the rule contributes to a **whitelist** for its stage.
 *   When at least one `include` rule fires for a stage, only entities
 *   inside one of those zones pass that stage.
 * - `exclude`: the rule contributes to a **blacklist** for its stage.
 *   Entities inside one of those zones are dropped at that stage.
 *
 * `monitor`-style observation (count without filtering) is not a rule
 * mode — zones without any matching rule are observed naturally by
 * `zone-analytics` (live snapshot + history), so an "I just want to
 * count, not filter" use case needs no rule at all.
 */
export const ZoneRuleModeEnum = z.enum(['include', 'exclude'])
export type ZoneRuleMode = z.infer<typeof ZoneRuleModeEnum>

/**
 * Per-consumer rule that references existing zones (geometry) and
 * defines how a specific pipeline stage should treat them. Each
 * consumer addon owns its own `ZoneRule[]` array in its per-device
 * settings:
 *
 * - `addon-motion-wasm` → `motionZoneRules: ZoneRule[]` (motion stage)
 * - `addon-detection-pipeline` → `detectionZoneRules: ZoneRule[]` (detection stage)
 * - future: notification rules, audio gating, etc.
 *
 * One rule applies to N zones (`zoneIds[]`) so the operator can
 * express "ignore motion in ALL of {garden, street}" with a single
 * rule. `classFilter` narrows the rule to specific object classes —
 * "drop person detections in the street, but keep cars" is one
 * `exclude` rule with `classFilter: ['person']`.
 *
 * `enabled` is a soft toggle — the operator can keep the rule
 * configured but inert without deleting it.
 */
export const ZoneRuleSchema = z.object({
  /** Stable rule id — survives edits, used by the UI for diffing. */
  id: z.string(),
  /** Optional human-readable label rendered in the rule editor. */
  name: z.string().optional(),
  /** Zones this rule targets. The rule's `mode` applies to ALL
   *  listed zones (OR-set: a detection in any one of them counts).
   *  At least one zone id required — a rule with no targets is a
   *  configuration mistake and the form validator rejects it. */
  zoneIds: z.array(z.string()).min(1).readonly(),
  mode: ZoneRuleModeEnum,
  /**
   * Class names this rule applies to. Empty / undefined ⇒ rule
   * applies to every class. Class strings match the `macroClass`
   * field on detections (e.g. `person`, `car`, `dog`).
   */
  classFilter: z.array(z.string()).readonly().optional(),
  /**
   * Minimum bbox/mask overlap (0–1) with any of the rule's zones
   * required to consider an entity "in the zone". Defaults to the
   * consumer's stage default when omitted. Kept for back-compat with
   * existing per-rule overrides; new operators pick the value via
   * `bboxInclusionPct` (operator-friendly 0–100). Whichever field is
   * set, the lower-level engine reads it as a 0–1 fraction.
   */
  overlapThreshold: z.number().min(0).max(1).optional(),
  /**
   * Operator-friendly version of `overlapThreshold` — the percentage
   * of the detection's bbox that must lie inside the zone for the
   * rule to match. Documented default is 85%; the engine substitutes
   * that when the field is omitted (kept optional so existing rules
   * stored without it stay valid).
   *
   * When BOTH `overlapThreshold` and `bboxInclusionPct` are set on a
   * rule, the engine prefers `bboxInclusionPct` because it's the
   * field exposed in the UI. Internally both feed the same gate.
   */
  bboxInclusionPct: z.number().min(0).max(100).optional(),
  /**
   * When `true` and a detection has a segmentation mask, use the
   * mask for overlap instead of the bbox. Detection-stage only;
   * motion rules ignore this field.
   */
  preferMask: z.boolean().optional(),
  /**
   * Soft-toggle: `false` disables the rule without deleting it.
   * Defaults to `true` so operators creating a rule via the UI
   * see it active immediately.
   */
  enabled: z.boolean().default(true),
  /**
   * Package stage only. When true, a package candidate may open from a
   * scene difference in this rule's zone after a person leaves. The
   * package model, when it boxes something overlapping, is extra evidence
   * and is not the gate. Absent or false keeps today's model path.
   */
  detectBySceneDifference: z.boolean().optional(),
  /**
   * Package stage only. When true, a promoted package is shown to the
   * `llm` cap before the delivery event is emitted. Absent or false emits
   * as today. Usable with or without `detectBySceneDifference`.
   */
  confirmWithLlm: z.boolean().optional(),
})
export type ZoneRule = z.infer<typeof ZoneRuleSchema>

/**
 * Convenience array schema — used by addon device-settings
 * contributions and runtime payloads (e.g. `RunnerCameraConfig`).
 */
export const ZoneRulesArraySchema = z.array(ZoneRuleSchema).readonly()
export type ZoneRules = z.infer<typeof ZoneRulesArraySchema>
