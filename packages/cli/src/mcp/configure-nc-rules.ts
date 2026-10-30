/**
 * `configure_notification_rule_questionnaire` and `configure_notification_rule_save`.
 *
 * Same stateless interview as the automation one, for a detection notification
 * rule: which cameras, which classes, which zones, quiet hours, who is told.
 * Choices (cameras, zones, targets) are read from the hub, so a question always
 * offers what exists. The save goes through `notificationRules.createRule` /
 * `updateRule`. An update sends the FULL `conditions` object: the store merges
 * `{ ...existing, ...patch }` one level deep, so a partial `conditions` would
 * silently drop every key the interview did not author (labels, exclusions,
 * scene gates…).
 */
import { MACRO_LABELS, NcRuleInputSchema, type NcRuleInput, type NcSchedule } from '@camstack/types'
import type { DryRunOutcome, GatedToolSpec, HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text } from '@camstack/develop'
import {
  ConfirmTokenSchema,
  adminGated,
  readCameras,
  type AdminGatedResult,
} from './configure-common.js'
import { readTargets, readZones, type TargetRef, type ZoneRef } from './configure-hub-reads.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'
import type {
  Choice,
  NeedAnswers,
  Problem,
  Question,
  Unavailable,
} from './configure-automations.js'

const TIME = /^\d{1,2}:\d{2}$/
const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6]

export const QuietHoursAnswerSchema = z.object({
  /** Notifications are muted from this time … */
  from: z.string().regex(TIME),
  /** … until this one (HH:MM, hub time zone). A window may cross midnight. */
  to: z.string().regex(TIME),
  /** Days the quiet window STARTS on (0 = Sunday); absent = every day. */
  days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
})
export type QuietHoursAnswer = z.infer<typeof QuietHoursAnswerSchema>

export const NcRuleAnswersSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  delivery: z.enum(['immediate', 'track-end']).optional(),
  /** Camera ids; `[]` means every camera. */
  cameras: z.array(z.number().int().nonnegative()).optional(),
  classes: z.array(z.string().min(1)).optional(),
  /** Zone ids or names; `[]` means anywhere in view. */
  zones: z.array(z.string().min(1)).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  /** `null` states "no quiet hours"; absent means not asked yet. */
  quietHours: QuietHoursAnswerSchema.nullable().optional(),
  /** Target ids or names. */
  targets: z.array(z.string().min(1)).optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
})
export type NcRuleAnswers = z.infer<typeof NcRuleAnswersSchema>

export interface NcRuleReady {
  readonly status: 'ready'
  readonly summary: readonly string[]
  readonly rule: NcRuleInput
  readonly next: string
}

export type NcRuleInterview = NeedAnswers | Unavailable | NcRuleReady

export const SAVE_RULE_TOOL = 'configure_notification_rule_save'

const DELIVERY_CHOICES: readonly Choice[] = [
  { value: 'immediate', label: 'as soon as it is seen (the first good frame)' },
  {
    value: 'track-end',
    label: 'once, when the subject has gone (one notification per visit)',
  },
]

function minuteOf(hhmm: string): number | null {
  const [h = '', m = ''] = hhmm.split(':')
  const hour = Number(h)
  const minute = Number(m)
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null
}

function scheduleOf(q: QuietHoursAnswer): NcSchedule | null {
  const start = minuteOf(q.from)
  const end = minuteOf(q.to)
  if (start === null || end === null || start === end) return null
  return {
    windows: [{ days: [...(q.days ?? ALL_DAYS)], startMinute: start, endMinute: end }],
    invert: true,
  }
}

function matchByIdOrName<T extends { readonly id: string; readonly name: string }>(
  wanted: readonly string[],
  known: readonly T[],
): { readonly hits: readonly T[]; readonly unknown: readonly string[] } {
  const hits: T[] = []
  const unknown: string[] = []
  for (const w of wanted) {
    const hit =
      known.find((k) => k.id === w) ?? known.find((k) => k.name.toLowerCase() === w.toLowerCase())
    if (hit === undefined) unknown.push(w)
    else if (!hits.includes(hit)) hits.push(hit)
  }
  return { hits, unknown }
}

export async function interviewNcRule(
  client: HubClient,
  answers: NcRuleAnswers,
): Promise<NcRuleInterview> {
  const questions: Question[] = []
  const problems: Problem[] = []

  const cameras = await readCameras(client)
  if (!cameras.ok) return { status: 'unavailable', reason: cameras.reason }
  const cameraIds = new Set(cameras.value.map((c) => c.id))

  if (answers.delivery === undefined) {
    questions.push({
      field: 'delivery',
      ask: 'When should it notify?',
      choices: DELIVERY_CHOICES,
    })
  }
  if (answers.cameras === undefined) {
    questions.push({
      field: 'cameras',
      ask: 'Which cameras? Send [] for every camera.',
      choices: cameras.value.map((c) => ({ value: c.id, label: c.name })),
    })
  } else {
    for (const id of answers.cameras) {
      if (!cameraIds.has(id))
        problems.push({
          field: 'cameras',
          problem: `device ${id} is not a camera on this hub`,
        })
    }
  }
  if ((answers.classes ?? []).length === 0) {
    questions.push({
      field: 'classes',
      ask: 'What should it notify about? One or more classes.',
      choices: MACRO_LABELS.map((l) => ({ value: l.id, label: l.id })),
    })
  }

  // Zones can only be offered once the cameras are known.
  let zones: ZoneRef[] = []
  let zoneIds: readonly string[] = []
  if (answers.cameras !== undefined && problems.length === 0) {
    const scope = answers.cameras.length > 0 ? answers.cameras : [...cameraIds]
    for (const id of scope) {
      const read = await readZones(client, id)
      if (!read.ok) return { status: 'unavailable', reason: read.reason }
      zones = [...zones, ...read.value]
    }
    if (answers.zones === undefined) {
      if (zones.length > 0) {
        questions.push({
          field: 'zones',
          ask: 'Only when the subject was in certain zones? Send zone ids or names, or [] for anywhere in view.',
          choices: zones.map((zn) => ({ value: zn.id, label: zn.name })),
        })
      }
    } else if (answers.zones.length > 0) {
      const matched = matchByIdOrName(answers.zones, zones)
      for (const u of matched.unknown)
        problems.push({
          field: 'zones',
          problem: `no zone "${u}" on the chosen cameras`,
        })
      zoneIds = matched.hits.map((zn) => zn.id)
    }
  }

  if (answers.quietHours === undefined) {
    questions.push({
      field: 'quietHours',
      ask: 'Quiet hours? Send null for none, or { from: "HH:MM", to: "HH:MM", days? }. It stays silent in that window; a window may cross midnight.',
    })
  } else if (answers.quietHours !== null && scheduleOf(answers.quietHours) === null) {
    problems.push({
      field: 'quietHours',
      problem: 'from and to must be two different times of day (HH:MM)',
    })
  }

  const targets = await readTargets(client)
  if (!targets.ok) return { status: 'unavailable', reason: targets.reason }
  let targetRefs: readonly TargetRef[] = []
  if ((answers.targets ?? []).length === 0) {
    questions.push({
      field: 'targets',
      ask:
        targets.value.length > 0
          ? 'Who is told? One or more targets.'
          : 'No notification target exists yet — add one in the admin UI first (configure_notification_targets or Notifications), then answer here.',
      choices: targets.value
        .filter((t) => t.enabled)
        .map((t) => ({ value: t.id, label: `${t.name} (${t.kind})` })),
    })
  } else {
    const matched = matchByIdOrName(answers.targets ?? [], targets.value)
    for (const u of matched.unknown)
      problems.push({
        field: 'targets',
        problem: `no notification target "${u}"`,
      })
    targetRefs = matched.hits
  }
  if (answers.name === undefined)
    questions.push({ field: 'name', ask: 'What should the rule be called?' })

  if (questions.length > 0 || problems.length > 0) {
    return { status: 'need-answers', questions, problems }
  }

  const cameraScope = answers.cameras ?? []
  const classes = answers.classes ?? []
  const schedule = answers.quietHours ? scheduleOf(answers.quietHours) : null
  const draft = {
    name: answers.name ?? '',
    enabled: true,
    delivery: answers.delivery ?? 'immediate',
    conditions: {
      ...(cameraScope.length > 0 ? { devices: [...cameraScope] } : {}),
      classes: [...classes],
      ...(zoneIds.length > 0 ? { zones: { ids: [...zoneIds] } } : {}),
      ...(answers.minConfidence !== undefined ? { minConfidence: answers.minConfidence } : {}),
      source: 'pipeline' as const,
    },
    ...(schedule !== null ? { schedule } : {}),
    targets: targetRefs.map((t) => ({ targetId: t.id })),
    media: { image: 'crop' as const },
    throttle: {
      cooldownSec: answers.cooldownSeconds ?? 60,
      scope: 'rule-device' as const,
    },
    priority: 3,
  }
  const parsed = NcRuleInputSchema.safeParse(draft)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      status: 'need-answers',
      questions: [],
      problems: [
        {
          field: issue ? issue.path.join('.') : 'rule',
          problem: issue?.message ?? 'the rule is incomplete',
        },
      ],
    }
  }
  const where =
    cameraScope.length === 0
      ? 'every camera'
      : cameraScope
          .map((id) => cameras.value.find((c) => c.id === id)?.name ?? String(id))
          .join(', ')
  const inZones =
    zoneIds.length > 0
      ? ` in ${zoneIds.map((id) => zones.find((zn) => zn.id === id)?.name ?? id).join(', ')}`
      : ''
  const summary = [
    `Notify ${answers.delivery === 'track-end' ? 'once when the subject has gone' : 'as soon as it is seen'}: ${classes.join(' or ')} on ${where}${inZones}`,
    `  to ${targetRefs.map((t) => t.name).join(', ')}`,
    answers.quietHours
      ? `  silent from ${answers.quietHours.from} to ${answers.quietHours.to}`
      : '  no quiet hours',
    `  at most once every ${parsed.data.throttle.cooldownSec}s per camera`,
  ]
  return {
    status: 'ready',
    summary,
    rule: parsed.data,
    next: `Call ${SAVE_RULE_TOOL} with { rule } for a preview, then again with the confirm_token to create it. Add ruleId to change an existing rule instead.`,
  }
}

export async function ncRuleQuestionnaire(
  ctx: McpContext,
  answers: NcRuleAnswers,
): Promise<NcRuleInterview | NoSessionResult> {
  return withHub(ctx, ({ client }) => interviewNcRule(client, answers))
}

// ---------------------------------------------------------------------------
// save

export interface SaveRuleArgs {
  readonly rule: NcRuleInput
  readonly ruleId?: string
}

const StoredRuleSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  schedule: z.unknown().optional(),
})

/** The condition keys the interview authors; everything else on a stored rule is kept. */
const AUTHORED_CONDITION_KEYS: readonly string[] = [
  'devices',
  'classes',
  'zones',
  'minConfidence',
  'source',
]

export interface UpdatePlan {
  readonly patch: Partial<NcRuleInput>
  readonly clear: readonly 'schedule'[]
}

/** The patch an update sends: the FULL conditions (stored keys kept, authored keys replaced). */
export function planUpdate(
  stored: z.infer<typeof StoredRuleSchema>,
  rule: NcRuleInput,
): UpdatePlan {
  const kept = Object.fromEntries(
    Object.entries(stored.conditions ?? {}).filter(
      ([key]) => !AUTHORED_CONDITION_KEYS.includes(key),
    ),
  )
  const conditions = { ...kept, ...rule.conditions }
  const patch = {
    name: rule.name,
    delivery: rule.delivery,
    conditions,
    targets: rule.targets,
    throttle: rule.throttle,
    ...(rule.schedule !== undefined ? { schedule: rule.schedule } : {}),
  }
  const clearSchedule =
    rule.schedule === undefined && stored.schedule !== undefined && stored.schedule !== null
  return { patch, clear: clearSchedule ? ['schedule'] : [] }
}

export function saveRuleSpec(client: HubClient): GatedToolSpec<SaveRuleArgs> {
  return {
    tool: SAVE_RULE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const parsed = NcRuleInputSchema.safeParse(args.rule)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          confirmable: false,
          describe: {
            problem: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid rule',
          },
        }
      }
      const targets = await readTargets(client)
      if (!targets.ok)
        return {
          confirmable: false,
          describe: {
            problem: `could not check the targets: ${targets.reason}`,
          },
        }
      const missing = parsed.data.targets.filter(
        (t) => !targets.value.some((k) => k.id === t.targetId),
      )
      if (missing.length > 0) {
        return {
          confirmable: false,
          describe: {
            problem: `unknown notification target(s): ${missing.map((m) => m.targetId).join(', ')}`,
          },
        }
      }
      if (args.ruleId === undefined) {
        return {
          confirmable: true,
          describe: {
            action: 'create notification rule',
            name: parsed.data.name,
            enabled: parsed.data.enabled,
            delivery: parsed.data.delivery,
            conditions: parsed.data.conditions,
            quietHours: parsed.data.schedule ?? null,
            targets: parsed.data.targets.length,
            effect: 'it starts notifying as soon as it is saved',
          },
        }
      }
      const stored = await readQuery(
        client,
        'notificationRules.getRule',
        { ruleId: args.ruleId },
        StoredRuleSchema,
      )
      if (!stored.ok)
        return {
          confirmable: false,
          describe: {
            problem: `could not read rule ${args.ruleId}: ${stored.reason}`,
          },
        }
      const plan = planUpdate(stored.value, parsed.data)
      return {
        confirmable: true,
        describe: {
          action: 'update notification rule',
          ruleId: args.ruleId,
          before: {
            name: stored.value.name,
            conditions: stored.value.conditions,
          },
          after: { name: plan.patch.name, conditions: plan.patch.conditions },
          clears: plan.clear,
          note: 'the full conditions are sent; keys this interview does not author are kept',
        },
      }
    },
    async execute(args) {
      const parsed = NcRuleInputSchema.parse(args.rule)
      if (args.ruleId === undefined) {
        const created = await client.call('POST', 'notificationRules.createRule', { rule: parsed })
        return { created: true, rule: created }
      }
      const stored = await client.call('GET', 'notificationRules.getRule', {
        ruleId: args.ruleId,
      })
      const plan = planUpdate(StoredRuleSchema.parse(stored), parsed)
      const updated = await client.call('POST', 'notificationRules.updateRule', {
        ruleId: args.ruleId,
        patch: plan.patch,
        ...(plan.clear.length > 0 ? { clear: [...plan.clear] } : {}),
      })
      return { updated: true, rule: updated }
    },
  }
}

export async function saveRule(
  ctx: McpContext,
  args: SaveRuleArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, saveRuleSpec, args, confirmToken)
}

const GATE_HOW =
  'Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.'

export function registerNcRuleTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_notification_rule_questionnaire',
    'Interview for a detection notification rule (cameras, classes, zones, quiet hours, targets). Stateless: send every answer so far in `answers`; it returns the questions still open, with choices read from the hub, or `ready` with a summary and the rule. Writes nothing.',
    { answers: NcRuleAnswersSchema },
    async ({ answers }): Promise<ToolTextResult> => text(await ncRuleQuestionnaire(ctx, answers)),
  )
  server.tool(
    SAVE_RULE_TOOL,
    `Create a notification rule (the \`rule\` of a ready questionnaire), or update the one named by ruleId (the full conditions are sent, so keys the interview does not author are kept). ${GATE_HOW}`,
    {
      rule: NcRuleInputSchema,
      ruleId: z.string().optional(),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ rule, ruleId, confirm_token }): Promise<ToolTextResult> =>
      text(
        await saveRule(ctx, { rule, ...(ruleId !== undefined ? { ruleId } : {}) }, confirm_token),
      ),
  )
}
