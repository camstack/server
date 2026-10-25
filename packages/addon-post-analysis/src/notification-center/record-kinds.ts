/**
 * Record kinds owned by the pipeline-analytics addon (records plan phase 2,
 * steps 18-24): the notification-center config tables.
 *
 * The notification-center module is hosted inside the pipeline-analytics addon.
 * That addon declares no `execution.group`, so the UDS owner stamp is the addon
 * id: `pipeline-analytics`. Declared hub-only (agents have no `ctx.records`).
 * One deploy covers all 7 kinds.
 */
import { z } from 'zod'
import {
  defineRecordKinds,
  NcRuleSchema,
  NcSharedSequenceSchema,
  TimelapseRuleSchema,
} from '@camstack/types'
import { NcCalendarEventsRuleSchema } from './calendar-events/calendar-events-rule.js'
import { NcRuleAiSchema } from './rule-ai.js'
import { NcLanguageSchema } from './text-catalog.js'
import { NcSummaryRuleSchema } from './summary/summary-rule.js'

// ── Legacy collection name constants (kept for mappers, adoption and docs) ──

/** Legacy collection for the text-catalog document. */
export const NC_TEXTS_COLLECTION = 'notification-center:texts'
/** Legacy collection for shared action sequences. */
export const NC_SEQUENCES_COLLECTION = 'notification-center:sequences'
/** Legacy collection for per-rule AI sections. */
export const NC_RULE_AI_COLLECTION = 'notification-center:rule-ai'
/** Legacy collection for calendar-events rules. */
export const NC_CALENDAR_EVENTS_RULES_COLLECTION = 'notification-center:calendar-events-rules'
/** Legacy collection for multi-camera digest rules. */
export const NC_SUMMARY_RULES_COLLECTION = 'notification-center:summary-rules'
/** Legacy collection for timelapse rules. */
export const NC_TIMELAPSE_RULES_COLLECTION = 'notification-center:timelapse-rules'
/** Legacy collection for notification rules. */
export const NC_RULES_COLLECTION = 'notification-center:rules'

// ── Body schemas (id is the record key, not in the body) ─────────────────────

/**
 * The hub language and operator-authored per-key overrides.
 * One row, id `texts`. Losing it degrades to the shipped English catalog.
 */
const TextsBodySchema = z.object({
  language: NcLanguageSchema,
  overrides: z.partialRecord(NcLanguageSchema, z.record(z.string(), z.string())),
})
export type TextsBody = z.infer<typeof TextsBodySchema>

/**
 * A shared action sequence (without id, which is the record key).
 * Extends the wire shape with `createdAt` / `updatedAt` (stored by the legacy table).
 */
const SequenceBodySchema = NcSharedSequenceSchema.omit({ id: true }).extend({
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type SequenceBody = z.infer<typeof SequenceBodySchema>

/**
 * The AI section of one ordinary rule. Record id = the rule id.
 */
const RuleAiBodySchema = z.object({
  ai: NcRuleAiSchema,
  updatedAt: z.number(),
})
export type RuleAiBody = z.infer<typeof RuleAiBodySchema>

/** A calendar-events rule (without `id`). */
const CalendarEventsRuleBodySchema = NcCalendarEventsRuleSchema.omit({ id: true })
export type CalendarEventsRuleBody = z.infer<typeof CalendarEventsRuleBodySchema>

/** A multi-camera digest rule (without `id`). */
const SummaryRuleBodySchema = NcSummaryRuleSchema.omit({ id: true })
export type SummaryRuleBody = z.infer<typeof SummaryRuleBodySchema>

/** A timelapse rule (without `id`). */
const TimelapseRuleBodySchema = TimelapseRuleSchema.omit({ id: true })
export type TimelapseRuleBody = z.infer<typeof TimelapseRuleBodySchema>

/** A notification rule (without `id`). */
export const RuleBodySchema = NcRuleSchema.omit({ id: true })
export type RuleBody = z.infer<typeof RuleBodySchema>

// ── Kind declarations ─────────────────────────────────────────────────────────

export const ncRecordKinds = defineRecordKinds({
  /**
   * The hub language + per-key text overrides. One row (id `texts`).
   */
  texts: {
    schema: TextsBodySchema,
    class: 'config',
    writeTrigger:
      'an operator changes the hub language (setLanguage) or replaces the per-key override set (setOverrides)',
    device: 'none',
    at: 'none',
    retention: {
      none: 'one row (id `texts`); losing it costs the chosen language and household wording, never a notification — every read degrades to the shipped English catalog',
    },
  },

  /**
   * Shared action sequences — named, ordered runs of steps with their own throttle.
   * One row per sequence, id = sequence UUID.
   */
  sequences: {
    schema: SequenceBodySchema,
    class: 'config',
    writeTrigger:
      'an admin creates/edits/deletes a shared sequence via notificationRules.createSequence / updateSequence / deleteSequence, or the one-shot boot migration that materialises legacy inline sequences',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row goes only when an admin deletes it; bounded by the sequence set a human is willing to author',
    },
  },

  /**
   * Per-rule AI section: whether and how a rule narrates itself.
   * Record id = the rule id it belongs to.
   */
  'rule-ai': {
    schema: RuleAiBodySchema,
    class: 'config',
    writeTrigger:
      'an operator switches the AI section of a notification rule on or off, or edits its prompt / word cap / language',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row goes when the operator clears the section or deletes the rule; bounded by the rule set a human is willing to author',
    },
  },

  /**
   * Calendar-events rules. One row per rule, id = rule UUID.
   */
  'calendar-events-rules': {
    schema: CalendarEventsRuleBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates or edits a calendar-events rule, or the producer stamps a delivered window via markGenerated',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'enabled', fields: ['enabled'] }],
    retention: {
      none: 'a row goes only when the operator deletes the rule; bounded by the rule set a human is willing to author',
    },
  },

  /**
   * Multi-camera digest rules. One row per rule, id = rule UUID.
   */
  'summary-rules': {
    schema: SummaryRuleBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates or edits a digest rule, or the producer stamps a delivered window via markGenerated',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'enabled', fields: ['enabled'] }],
    retention: {
      none: 'a row goes only when the operator deletes the rule; bounded by the rule set a human is willing to author',
    },
  },

  /**
   * Timelapse rules. One row per rule, id = rule UUID.
   * Three rows on prod (2026-10-18).
   */
  'timelapse-rules': {
    schema: TimelapseRuleBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates or edits a timelapse rule, or the scheduler stamps a successful per-camera generation via markGenerated',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'enabled', fields: ['enabled'] }],
    retention: {
      none: 'a row goes only when the operator deletes the rule; bounded by the rule set a human is willing to author',
    },
  },

  /**
   * Notification rules — the main rule set. One row per rule, id = rule UUID.
   * 18 rows on prod (2026-10-18); most coupled kind in this owner.
   */
  rules: {
    schema: RuleBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates, edits, enables/disables a rule or opts a target out of it; nothing writes on the evaluation path',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'delivery', fields: ['delivery'] }],
    retention: {
      none: 'a row goes only when the operator deletes the rule; bounded by the rule set a human is willing to author',
    },
  },
})
