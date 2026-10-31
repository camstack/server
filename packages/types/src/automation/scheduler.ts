/**
 * Schedulers (D983) — an entity that performs actions over the day.
 *
 * A scheduler has profiles; a profile has weekdays and a timeline of POINTS.
 * A point is an `edge` (run once at its time), a `hold` (from this point until
 * the next point of the profile, keep the steps' effects true) or a `release`
 * (end the current hold without acting). The scheduler AND each profile carry
 * a manual `enabled` flag and an optional `activeWhen`: a `when` STATE tree
 * (facts only — an event leaf is an instant and cannot be "in force").
 *
 * This file is the data half: the schemas, and the author-time rules that
 * decide whether a scheduler can be saved at all (a hold needs an action that
 * leads to a state; a sun point needs the site location). It holds no runtime.
 */
import { z } from 'zod'
import { actionEffect } from '../device/cap-vocabulary/action-index.js'
import {
  type SiteReading,
  TimeSpecSchema,
  validateTimeSpecForSite,
  WeekdayKeySchema,
} from '../time/time-spec.js'
import { ActionStepSchema, normalizeCapStep } from './recipe.js'
import {
  type AutomationWhen,
  AutomationWhenSchema,
  hasEventLeaves,
  validateWhenTree,
} from './when.js'

/** A `when` tree that is a STATE: no event leaf, and legal as a tree. */
export const SchedulerStateTreeSchema: z.ZodType<AutomationWhen> = AutomationWhenSchema.superRefine(
  (when, ctx) => {
    if (hasEventLeaves(when)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a scheduler condition is a state — an event ("becomes", "detects", "at a time") is an instant and cannot be in force',
      })
      return
    }
    const problem = validateWhenTree(when)
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
  },
)

/** A point's moment: a clock time or a sun event. A one-shot date is not a position on a day. */
export const SchedulerTimeSpecSchema = TimeSpecSchema.refine((spec) => spec.kind !== 'date', {
  message:
    'a scheduler point is a clock time or a sun event — a one-shot date has no place on a timeline',
})

export const SchedulerPointModeSchema = z.enum(['edge', 'hold', 'release'])
export type SchedulerPointMode = z.infer<typeof SchedulerPointModeSchema>

/** What a hold does when someone changes the device by hand. */
export const HoldOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('respect') }),
  z.object({
    mode: z.literal('reassert'),
    /** How long the manual state is left alone before the hold puts its own back. */
    graceMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000),
  }),
])
export type HoldOverride = z.infer<typeof HoldOverrideSchema>

export const DEFAULT_HOLD_OVERRIDE: HoldOverride = { mode: 'respect' }
/** Re-applications of a hold per window before it gives up. */
export const DEFAULT_MAX_HOLD_ATTEMPTS = 3
export const MAX_HOLD_ATTEMPTS_LIMIT = 20
/** A missed edge up to this late still runs. */
export const DEFAULT_MAX_LATE_MS = 10 * 60_000

export const SchedulerPointSchema = z.object({
  id: z.string().min(1).max(64),
  at: SchedulerTimeSpecSchema,
  mode: SchedulerPointModeSchema,
  /** The actions of an `edge` or `hold`; a `release` has none. */
  steps: z.array(ActionStepSchema).max(20).default([]),
  /** Checked when the point runs (an edge) or is applied (a hold). */
  conditions: SchedulerStateTreeSchema.optional(),
  /** Hold only; absent means `respect`. */
  override: HoldOverrideSchema.optional(),
  /** Hold only: re-applications per window; absent means {@link DEFAULT_MAX_HOLD_ATTEMPTS}. */
  maxHoldAttempts: z.number().int().min(1).max(MAX_HOLD_ATTEMPTS_LIMIT).optional(),
})
export type SchedulerPoint = z.infer<typeof SchedulerPointSchema>

export const SchedulerProfileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  activeWhen: SchedulerStateTreeSchema.optional(),
  days: z.array(WeekdayKeySchema).min(1).max(7),
  points: z.array(SchedulerPointSchema).max(50),
})
export type SchedulerProfile = z.infer<typeof SchedulerProfileSchema>

/** What an operator writes. */
export const SchedulerInputSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  activeWhen: SchedulerStateTreeSchema.optional(),
  /** Higher wins when two holds want the same device in different states. */
  priority: z.number().int().min(0).max(100).default(0),
  maxLateMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 3_600_000)
    .default(DEFAULT_MAX_LATE_MS),
  profiles: z.array(SchedulerProfileSchema).max(20),
})
export type SchedulerInput = z.infer<typeof SchedulerInputSchema>

export const SchedulerSchema = SchedulerInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Scheduler = z.infer<typeof SchedulerSchema>

/** Every outcome a scheduler reports to the runs ledger (`AutomationRunTrace.scheduler`). */
export const SchedulerOutcomeSchema = z.enum([
  'done',
  'missed',
  'inactive',
  'condition-false',
  'failed',
  'held',
  'gave-up',
  'overridden',
  'suspended-manual',
])
export type SchedulerOutcome = z.infer<typeof SchedulerOutcomeSchema>

// ── author-time rules ──────────────────────────────────────────────────────

export interface SchedulerIssue {
  /** `profiles.0.points.2.steps.1` — where the editor puts the message. */
  readonly path: string
  readonly message: string
}

export type SchedulerValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly SchedulerIssue[] }

const VAR_TARGET_REFUSAL =
  'a scheduler has no run scope, so a $var target cannot be resolved — pick devices or a domain'

function isVarTarget(step: SchedulerPoint['steps'][number]): boolean {
  return step.kind === 'cap' && normalizeCapStep(step).target.kind === 'var'
}

/** Why `step` cannot be HELD, or `null` when it can (it leads to a state). */
export function holdRefusalOf(step: SchedulerPoint['steps'][number]): string | null {
  if (step.kind === 'wait') return 'a wait is not an action and cannot be held'
  const normalized = normalizeCapStep(step)
  if (normalized.actionId === undefined) {
    return `${step.cap}.${step.method} is a raw call, not a vocabulary action — only an action that leads to a state can be held`
  }
  if (actionEffect(normalized.actionId, step.args) === null) {
    return `"${normalized.actionId}" does not lead to a state (or its value is not set), so there is nothing to keep true — use an edge point`
  }
  return null
}

/**
 * Can this scheduler be saved at this site? Every refusal carries its reason.
 * Pure: the site reading is handed in.
 */
export function validateSchedulerInput(
  input: SchedulerInput,
  reading: SiteReading,
): SchedulerValidation {
  const issues: SchedulerIssue[] = []
  input.profiles.forEach((profile, pi) => {
    const ids = new Set<string>()
    profile.points.forEach((point, qi) => {
      const base = `profiles.${pi}.points.${qi}`
      if (ids.has(point.id))
        issues.push({
          path: `${base}.id`,
          message: `point id "${point.id}" is used twice`,
        })
      ids.add(point.id)
      const timing = validateTimeSpecForSite(point.at, reading)
      if (!timing.ok) issues.push({ path: `${base}.at`, message: timing.message })
      if (point.mode === 'release') {
        if (point.steps.length > 0) {
          issues.push({
            path: `${base}.steps`,
            message: 'a release ends a hold without acting — it has no steps',
          })
        }
        return
      }
      if (point.steps.length === 0) {
        issues.push({
          path: `${base}.steps`,
          message: `a${point.mode === 'edge' ? 'n' : ''} ${point.mode} point needs at least one step`,
        })
      }
      if (point.mode === 'edge') {
        point.steps.forEach((step, si) => {
          if (isVarTarget(step))
            issues.push({
              path: `${base}.steps.${si}`,
              message: VAR_TARGET_REFUSAL,
            })
        })
        if (point.override !== undefined || point.maxHoldAttempts !== undefined) {
          issues.push({
            path: base,
            message: 'override and maxHoldAttempts belong to a hold, not an edge',
          })
        }
        return
      }
      point.steps.forEach((step, si) => {
        if (isVarTarget(step)) {
          issues.push({
            path: `${base}.steps.${si}`,
            message: VAR_TARGET_REFUSAL,
          })
          return
        }
        const refusal = holdRefusalOf(step)
        if (refusal !== null) issues.push({ path: `${base}.steps.${si}`, message: refusal })
      })
    })
  })
  const profileIds = new Set<string>()
  input.profiles.forEach((profile, pi) => {
    if (profileIds.has(profile.id)) {
      issues.push({
        path: `profiles.${pi}.id`,
        message: `profile id "${profile.id}" is used twice`,
      })
    }
    profileIds.add(profile.id)
  })
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}

// ── refusals, preview, conflicts, status ───────────────────────────────────

export const SchedulerErrorCodeSchema = z.enum(['not-found', 'invalid-scheduler', 'invalid-date'])
export type SchedulerErrorCode = z.infer<typeof SchedulerErrorCodeSchema>

/** A refusal with a reason a caller can branch on; the code leads the message. */
export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode
  constructor(code: SchedulerErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'SchedulerError'
    this.code = code
  }
}

export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** One point of the day, placed. `at` is `null` when the sun never crosses that day. */
export const SchedulerPreviewPointSchema = z.object({
  pointId: z.string(),
  mode: SchedulerPointModeSchema,
  at: z.number().nullable(),
  /** A hold: when its window ends (the next point, else the end of the day). */
  until: z.number().nullable(),
  /** The point's steps are held on a different scheduler's claim at this time — see `conflicts`. */
  stepCount: z.number().int(),
})
export type SchedulerPreviewPoint = z.infer<typeof SchedulerPreviewPointSchema>

export const SchedulerPreviewSchema = z.object({
  schedulerId: z.string(),
  /** The site-local day previewed. */
  date: z.string().regex(LOCAL_DATE_PATTERN),
  timeZone: z.string(),
  /** Why no profile is in force, or `null` when one is. */
  idleReason: z.string().nullable(),
  /** The profile in force that day: first in list order whose rules hold. */
  profileId: z.string().nullable(),
  points: z.array(SchedulerPreviewPointSchema),
})
export type SchedulerPreview = z.infer<typeof SchedulerPreviewSchema>

/** Two holds that want the same device in different states at the same time. */
export const SchedulerConflictSchema = z.object({
  deviceId: z.number().int(),
  cap: z.string(),
  field: z.string(),
  mine: z.object({
    profileId: z.string(),
    pointId: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    priority: z.number().int(),
  }),
  other: z.object({
    schedulerId: z.string(),
    schedulerName: z.string(),
    profileId: z.string(),
    pointId: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    priority: z.number().int(),
  }),
  /** The overlapping stretch, as site-local minutes of the day. */
  fromMinute: z.number().int(),
  toMinute: z.number().int(),
  /** `mine` | `other` | `tie` — who holds when it happens (a tie: the one that started first). */
  winner: z.enum(['mine', 'other', 'tie']),
})
export type SchedulerConflict = z.infer<typeof SchedulerConflictSchema>

export const HoldTargetStatusSchema = z.enum([
  'pending',
  'held',
  'suspended-manual',
  'gave-up',
  'overridden',
])
export type HoldTargetStatus = z.infer<typeof HoldTargetStatusSchema>

export const SchedulerStatusSchema = z.object({
  schedulerId: z.string(),
  profileId: z.string().nullable(),
  /** The hold in force right now, with where each target stands. */
  hold: z
    .object({
      pointId: z.string(),
      until: z.number(),
      /** `true` while the scheduler or profile `activeWhen` is false. */
      suspendedInactive: z.boolean(),
      targets: z.array(
        z.object({
          deviceId: z.number().int(),
          cap: z.string(),
          field: z.string(),
          status: HoldTargetStatusSchema,
          attempts: z.number().int(),
        }),
      ),
    })
    .nullable(),
})
export type SchedulerStatus = z.infer<typeof SchedulerStatusSchema>
