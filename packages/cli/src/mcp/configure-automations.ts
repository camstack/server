/**
 * `configure_automation_questionnaire` and `configure_automation_save`.
 *
 * The interview is STATELESS: the caller sends every answer it has so far, and
 * the tool answers with either the next questions (`need-answers`, only what is
 * missing, with choices read from the hub) or `ready` with a readable summary
 * and the recipe. Nothing is stored between calls and nothing is written until
 * `configure_automation_save` passes the mutation gate.
 *
 * The recipe is the admin editor's recipe — `AutomationRecipeSchema`, the
 * bounds check and the same `prepareRecipeUnits` save boundary (D972), so a
 * number on a quantity field is saved with its unit and a unit that cannot
 * belong to the field is refused here with the server's own message. The save
 * writes the generated block through `coreBlocks.create`, exactly as the editor.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  AutomationRecipeSchema,
  MACRO_LABELS,
  capUnitResolver,
  convertLegacyWhen,
  countWhenLeaves,
  generateAutomationBlock,
  isReadingQuantity,
  prepareRecipeUnits,
  unitsForQuantity,
  validateRecipeBounds,
  type AutomationAction,
  type AutomationConditionOperator,
  type AutomationRecipe,
  type AutomationWhen,
  type LegacyCondition,
  type LegacyTrigger,
  type UnitResolver,
} from '@camstack/types'
import type { DryRunOutcome, GatedToolSpec, HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text } from './tool-result.js'
import {
  ConfirmTokenSchema,
  adminGated,
  readCameras,
  type AdminGatedResult,
} from './configure-common.js'
import {
  readBoundCaps,
  readWireableFields,
  readZones,
  type WireableField,
  type ZoneRef,
} from './configure-hub-reads.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'

// ---------------------------------------------------------------------------
// answers

const QuantityAnswerSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
})
const ValueAnswerSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  QuantityAnswerSchema,
])

const OPERATORS: readonly AutomationConditionOperator[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
]

export const ConditionAnswerSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  operator: z.enum(OPERATORS),
  value: ValueAnswerSchema,
})
export type ConditionAnswer = z.infer<typeof ConditionAnswerSchema>

export const ActionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), seconds: z.number().min(0).max(300) }),
  z.object({
    kind: z.literal('cap'),
    deviceId: z.union([
      z.number().int().nonnegative(),
      z.array(z.number().int().nonnegative()).min(1),
    ]),
    cap: z.string().min(1),
    method: z.string().min(1),
    /** A quantity argument is `{ value, unit }`; a bare number is stamped with the declared unit. */
    args: z.record(z.string(), z.unknown()).optional(),
  }),
])
export type ActionAnswer = z.infer<typeof ActionAnswerSchema>

export const AutomationTriggerAnswerSchema = z.object({
  kind: z.enum(['detection', 'device-state', 'schedule']),
  // detection
  cameras: z.array(z.number().int().nonnegative()).optional(),
  classes: z.array(z.string().min(1)).optional(),
  /** Zone ids or names; an empty list means "anywhere in view". */
  zones: z.array(z.string().min(1)).optional(),
  minScore: z.number().min(0).max(1).optional(),
  // device-state
  deviceId: z.number().int().nonnegative().optional(),
  cap: z.string().min(1).optional(),
  fieldPath: z.string().min(1).optional(),
  becomes: z.union([z.string(), z.number(), z.boolean()]).optional(),
  anyChange: z.boolean().optional(),
  forSeconds: z.number().int().min(0).max(86_400).optional(),
  // schedule
  time: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  cron: z.string().min(1).max(120).optional(),
})
export type AutomationTriggerAnswer = z.infer<typeof AutomationTriggerAnswerSchema>

export const AutomationAnswersSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  trigger: AutomationTriggerAnswerSchema.optional(),
  /** `[]` states "no extra conditions"; absent means not asked yet. */
  conditions: z.array(ConditionAnswerSchema).optional(),
  actions: z.array(ActionAnswerSchema).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
})
export type AutomationAnswers = z.infer<typeof AutomationAnswersSchema>

// ---------------------------------------------------------------------------
// result

export interface Choice {
  readonly value: string | number
  readonly label: string
}

export interface Question {
  readonly field: string
  readonly ask: string
  readonly choices?: readonly Choice[]
}

export interface Problem {
  readonly field: string
  readonly problem: string
}

export interface NeedAnswers {
  readonly status: 'need-answers'
  readonly questions: readonly Question[]
  readonly problems: readonly Problem[]
}

export interface Unavailable {
  readonly status: 'unavailable'
  readonly reason: string
}

export interface QuantityNote {
  readonly where: string
  readonly value: number
  readonly unit: string
}

export interface AutomationReady {
  readonly status: 'ready'
  readonly name: string
  readonly summary: readonly string[]
  readonly recipe: AutomationRecipe
  readonly quantities: readonly QuantityNote[]
  readonly notes: readonly string[]
  readonly next: string
}

export type AutomationInterview = NeedAnswers | Unavailable | AutomationReady

export const SAVE_AUTOMATION_TOOL = 'configure_automation_save'

const MACRO_CHOICES: readonly Choice[] = MACRO_LABELS.map((l) => ({
  value: l.id,
  label: l.id,
}))
const CRON_FIELDS = 5

let defaultResolver: UnitResolver | undefined
function unitResolver(): UnitResolver {
  defaultResolver ??= capUnitResolver(ALL_CAPABILITY_DEFINITIONS)
  return defaultResolver
}

function need(questions: readonly Question[], problems: readonly Problem[]): NeedAnswers {
  return { status: 'need-answers', questions, problems }
}

// ---------------------------------------------------------------------------
// interview

const NO_CONDITIONS_NOTE =
  'Automations have no time-window condition: the recipe vocabulary is trigger, conditions on device values, actions. Quiet hours belong to a notification rule (configure_notification_rule_questionnaire) or to a schedule trigger.'

const CONDITIONS_QUESTION: Question = {
  field: 'conditions',
  ask: 'Any extra conditions that must also hold when it fires? Send [] for none. Each is { deviceId, cap, fieldPath, operator: eq|ne|gt|gte|lt|lte|contains|in, value }. A number tied to a physical quantity is { value, unit } (for example { "value": 50, "unit": "g" }); a bare number is taken as the field\'s base unit and reported.',
}

const ACTIONS_QUESTION: Question = {
  field: 'actions',
  ask: 'What should it do? A list of steps, in order: { kind: "cap", deviceId, cap, method, args? } or { kind: "wait", seconds }. deviceId may be a list to run the same call on several devices.',
}

function fieldChoices(fields: readonly WireableField[]): readonly Choice[] {
  return fields.map((f) => {
    const units =
      f.quantity !== undefined && isReadingQuantity(f.quantity) ? unitsForQuantity(f.quantity) : []
    const detail = [
      f.kind,
      f.enumValues !== undefined ? `one of ${f.enumValues.join('|')}` : undefined,
      units.length > 0 ? `units ${units.join('/')}` : undefined,
    ].filter((p): p is string => p !== undefined)
    return { value: `${f.cap}.${f.path}`, label: detail.join(', ') }
  })
}

interface TriggerOutcome {
  readonly trigger?: LegacyTrigger
  readonly questions: readonly Question[]
  readonly problems: readonly Problem[]
  readonly unavailable?: string
  readonly summary?: string
}

function resolveZones(
  wanted: readonly string[],
  known: readonly ZoneRef[],
): { readonly ids: readonly string[]; readonly unknown: readonly string[] } {
  const ids: string[] = []
  const unknown: string[] = []
  for (const w of wanted) {
    const hit =
      known.find((zn) => zn.id === w) ??
      known.find((zn) => zn.name.toLowerCase() === w.toLowerCase())
    if (hit === undefined) unknown.push(w)
    else if (!ids.includes(hit.id)) ids.push(hit.id)
  }
  return { ids, unknown }
}

async function detectionTrigger(
  client: HubClient,
  t: AutomationTriggerAnswer,
): Promise<TriggerOutcome> {
  const questions: Question[] = []
  const problems: Problem[] = []
  const cameras = await readCameras(client)
  if (!cameras.ok) return { questions, problems, unavailable: cameras.reason }
  const byId = new Map(cameras.value.map((c) => [c.id, c.name]))
  const chosen = t.cameras ?? []
  if (chosen.length === 0) {
    questions.push({
      field: 'trigger.cameras',
      ask: 'Which cameras should trigger it?',
      choices: cameras.value.map((c) => ({ value: c.id, label: c.name })),
    })
  }
  for (const id of chosen) {
    if (!byId.has(id))
      problems.push({
        field: 'trigger.cameras',
        problem: `device ${id} is not a camera on this hub`,
      })
  }
  if ((t.classes ?? []).length === 0) {
    questions.push({
      field: 'trigger.classes',
      ask: 'What should it react to? One or more classes; a macro class (person, vehicle, animal, package) matches every raw class under it.',
      choices: MACRO_CHOICES,
    })
  }
  if (questions.length > 0 || problems.length > 0) return { questions, problems }
  const zones: ZoneRef[] = []
  for (const id of chosen) {
    const read = await readZones(client, id)
    if (!read.ok) return { questions, problems, unavailable: read.reason }
    zones.push(...read.value)
  }
  let zoneIds: readonly string[] | undefined
  if (t.zones === undefined && zones.length > 0) {
    return {
      questions: [
        {
          field: 'trigger.zones',
          ask: 'Only when the subject was in certain zones? Send zone ids or names, or [] for anywhere in view.',
          choices: zones.map((zn) => ({ value: zn.id, label: zn.name })),
        },
      ],
      problems,
    }
  }
  if (t.zones !== undefined && t.zones.length > 0) {
    const resolved = resolveZones(t.zones, zones)
    for (const u of resolved.unknown) {
      problems.push({
        field: 'trigger.zones',
        problem: `no zone "${u}" on the chosen cameras`,
      })
    }
    zoneIds = resolved.ids
  }
  if (problems.length > 0) {
    return {
      questions: [
        {
          field: 'trigger.zones',
          ask: 'Pick zones that exist on the chosen cameras, or [] for anywhere.',
          choices: zones.map((zn) => ({ value: zn.id, label: zn.name })),
        },
      ],
      problems,
    }
  }
  const classes = t.classes ?? []
  const trigger: LegacyTrigger = {
    kind: 'detection',
    classes: [...classes],
    deviceIds: [...chosen],
    ...(zoneIds !== undefined && zoneIds.length > 0 ? { zones: [...zoneIds] } : {}),
    ...(t.minScore !== undefined ? { minScore: t.minScore } : {}),
  }
  const where = chosen.map((id) => byId.get(id) ?? String(id)).join(', ')
  const inZones =
    zoneIds !== undefined && zoneIds.length > 0
      ? ` in ${zoneIds.map((id) => zones.find((zn) => zn.id === id)?.name ?? id).join(', ')}`
      : ''
  return {
    trigger,
    questions,
    problems,
    summary: `When ${classes.join(' or ')} is seen on ${where}${inZones}`,
  }
}

async function deviceStateTrigger(
  client: HubClient,
  t: AutomationTriggerAnswer,
): Promise<TriggerOutcome> {
  if (t.deviceId === undefined) {
    return {
      questions: [
        {
          field: 'trigger.deviceId',
          ask: 'Which device (its numeric id) should be watched? ops_unhealthy_devices and ops_device show ids.',
        },
      ],
      problems: [],
    }
  }
  const fields = await readWireableFields(client, t.deviceId)
  if (!fields.ok) return { questions: [], problems: [], unavailable: fields.reason }
  const chosen = fields.value.find((f) => f.cap === t.cap && f.path === t.fieldPath)
  if (chosen === undefined) {
    return {
      questions: [
        {
          field: 'trigger.cap / trigger.fieldPath',
          ask: `Which value of device ${t.deviceId}? Send cap and fieldPath.`,
          choices: fieldChoices(fields.value),
        },
      ],
      problems:
        t.cap === undefined && t.fieldPath === undefined
          ? []
          : [
              {
                field: 'trigger.fieldPath',
                problem: `device ${t.deviceId} has no ${t.cap}.${t.fieldPath}`,
              },
            ],
    }
  }
  if (t.becomes === undefined && t.anyChange !== true) {
    const kindHint =
      chosen.kind === 'enum' && chosen.enumValues !== undefined
        ? chosen.enumValues.map((v): Choice => ({ value: v, label: v }))
        : chosen.kind === 'boolean'
          ? [
              { value: 'true', label: 'on / true' },
              { value: 'false', label: 'off / false' },
            ]
          : undefined
    return {
      questions: [
        {
          field: 'trigger.becomes',
          ask: `Fire when ${chosen.cap}.${chosen.path} becomes which value? Or send trigger.anyChange: true to fire on any change.`,
          ...(kindHint !== undefined ? { choices: kindHint } : {}),
        },
      ],
      problems: [],
    }
  }
  const problems: Problem[] = []
  if (t.becomes !== undefined) {
    const ok =
      chosen.kind === 'number'
        ? typeof t.becomes === 'number'
        : chosen.kind === 'boolean'
          ? typeof t.becomes === 'boolean'
          : typeof t.becomes === 'string' &&
            (chosen.enumValues === undefined || chosen.enumValues.includes(t.becomes))
    if (!ok) {
      problems.push({
        field: 'trigger.becomes',
        problem: `${chosen.cap}.${chosen.path} is a ${chosen.kind}${chosen.enumValues ? ` (one of ${chosen.enumValues.join(', ')})` : ''}; ${JSON.stringify(t.becomes)} does not fit`,
      })
    }
  }
  if (problems.length > 0) return { questions: [], problems }
  const trigger: LegacyTrigger = {
    kind: 'device-state',
    deviceId: t.deviceId,
    cap: chosen.cap,
    fieldPath: chosen.path,
    ...(t.becomes !== undefined ? { becomes: t.becomes, edge: true } : {}),
    ...(t.forSeconds !== undefined ? { forMs: t.forSeconds * 1000 } : {}),
  }
  const what = t.becomes !== undefined ? `becomes ${JSON.stringify(t.becomes)}` : 'changes'
  return {
    trigger,
    questions: [],
    problems: [],
    summary: `When device ${t.deviceId} ${chosen.cap}.${chosen.path} ${what}${t.forSeconds ? ` for ${t.forSeconds}s` : ''}`,
  }
}

function scheduleTrigger(t: AutomationTriggerAnswer): TriggerOutcome {
  if (t.cron !== undefined) {
    if (t.cron.trim().split(/\s+/).length !== CRON_FIELDS) {
      return {
        questions: [],
        problems: [
          {
            field: 'trigger.cron',
            problem: 'a cron expression has five fields: minute hour day month weekday',
          },
        ],
      }
    }
    return {
      trigger: { kind: 'schedule', cron: t.cron.trim() },
      questions: [],
      problems: [],
      summary: `On the schedule "${t.cron.trim()}"`,
    }
  }
  if (t.time === undefined) {
    return {
      questions: [
        {
          field: 'trigger.time',
          ask: 'At what time (HH:MM, hub time zone)? Optionally trigger.days (0=Sunday…6=Saturday), or a raw trigger.cron instead.',
        },
      ],
      problems: [],
    }
  }
  const [hh = '', mm = ''] = t.time.split(':')
  const hour = Number(hh)
  const minute = Number(mm)
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    return {
      questions: [],
      problems: [{ field: 'trigger.time', problem: `${t.time} is not a time of day` }],
    }
  }
  const days = t.days === undefined ? '*' : [...new Set(t.days)].toSorted((a, b) => a - b).join(',')
  return {
    trigger: { kind: 'schedule', cron: `${minute} ${hour} * * ${days}` },
    questions: [],
    problems: [],
    summary: `Every ${t.days === undefined ? 'day' : `day of week ${days}`} at ${t.time}`,
  }
}

async function buildTrigger(
  client: HubClient,
  t: AutomationTriggerAnswer,
): Promise<TriggerOutcome> {
  switch (t.kind) {
    case 'detection':
      return detectionTrigger(client, t)
    case 'device-state':
      return deviceStateTrigger(client, t)
    case 'schedule':
      return scheduleTrigger(t)
  }
}

function leafProblem(
  leaf: ConditionAnswer,
  field: WireableField | undefined,
  idx: number,
): string | null {
  const at = `conditions[${idx}]`
  if (field === undefined)
    return `${at}: device ${leaf.deviceId} has no ${leaf.cap}.${leaf.fieldPath}`
  const v = leaf.value
  const isQuantity = typeof v === 'object' && !Array.isArray(v)
  if (isQuantity) {
    if (field.kind !== 'number')
      return `${at}: ${leaf.cap}.${leaf.fieldPath} is a ${field.kind}, it takes no unit`
    return null
  }
  if (leaf.operator === 'in' && !Array.isArray(v)) return `${at}: operator "in" takes a list`
  if (leaf.operator !== 'in' && Array.isArray(v)) return `${at}: only operator "in" takes a list`
  if (
    field.kind === 'number' &&
    ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(leaf.operator) &&
    typeof v !== 'number'
  ) {
    return `${at}: ${leaf.cap}.${leaf.fieldPath} is a number`
  }
  if (field.kind === 'boolean' && typeof v !== 'boolean')
    return `${at}: ${leaf.cap}.${leaf.fieldPath} is true/false`
  if (
    field.kind === 'enum' &&
    field.enumValues !== undefined &&
    typeof v === 'string' &&
    leaf.operator !== 'contains' &&
    !field.enumValues.includes(v)
  ) {
    return `${at}: ${leaf.cap}.${leaf.fieldPath} is one of ${field.enumValues.join(', ')}`
  }
  return null
}

async function checkConditions(
  client: HubClient,
  conditions: readonly ConditionAnswer[],
): Promise<{
  readonly problems: readonly Problem[]
  readonly unavailable?: string
}> {
  const problems: Problem[] = []
  const cache = new Map<number, readonly WireableField[]>()
  for (const [idx, leaf] of conditions.entries()) {
    let fields = cache.get(leaf.deviceId)
    if (fields === undefined) {
      const read = await readWireableFields(client, leaf.deviceId)
      if (!read.ok) return { problems, unavailable: read.reason }
      fields = read.value
      cache.set(leaf.deviceId, fields)
    }
    const found = fields.find((f) => f.cap === leaf.cap && f.path === leaf.fieldPath)
    const problem = leafProblem(leaf, found, idx)
    if (problem !== null) problems.push({ field: 'conditions', problem })
  }
  return { problems }
}

async function checkActions(
  client: HubClient,
  actions: readonly ActionAnswer[],
): Promise<{
  readonly problems: readonly Problem[]
  readonly unavailable?: string
}> {
  const problems: Problem[] = []
  const cache = new Map<number, readonly string[]>()
  for (const [idx, action] of actions.entries()) {
    if (action.kind !== 'cap') continue
    const ids = Array.isArray(action.deviceId) ? action.deviceId : [action.deviceId]
    for (const id of ids) {
      let caps = cache.get(id)
      if (caps === undefined) {
        const read = await readBoundCaps(client, id)
        if (!read.ok) return { problems, unavailable: read.reason }
        caps = read.value
        cache.set(id, caps)
      }
      if (!caps.includes(action.cap)) {
        problems.push({
          field: 'actions',
          problem: `actions[${idx}]: device ${id} has no capability "${action.cap}" bound (it has: ${caps.join(', ') || 'none'})`,
        })
      }
    }
  }
  return { problems }
}

function toCondition(leaves: readonly ConditionAnswer[]): LegacyCondition | undefined {
  if (leaves.length === 0) return undefined
  const mapped: LegacyCondition[] = leaves.map((l) => ({
    kind: 'condition',
    deviceId: l.deviceId,
    cap: l.cap,
    fieldPath: l.fieldPath,
    operator: l.operator,
    value: l.value,
  }))
  const [first] = mapped
  if (mapped.length === 1 && first !== undefined) return first
  return { kind: 'all', children: mapped }
}

function toActions(actions: readonly ActionAnswer[]): AutomationAction[] {
  return actions.map((a): AutomationAction => {
    if (a.kind === 'wait') return { kind: 'wait', seconds: a.seconds }
    return {
      kind: 'cap',
      deviceId: Array.isArray(a.deviceId) ? [...a.deviceId] : a.deviceId,
      cap: a.cap,
      method: a.method,
      ...(a.args !== undefined ? { args: a.args } : {}),
    }
  })
}

function quantityNotes(recipe: AutomationRecipe): QuantityNote[] {
  const notes: QuantityNote[] = []
  const walk = (c: AutomationWhen, path: string): void => {
    if (c.kind === 'device-is' && typeof c.value === 'number' && c.unit !== undefined) {
      notes.push({
        where: `${path} ${c.cap}.${c.fieldPath}`,
        value: c.value,
        unit: c.unit,
      })
    }
    if (c.kind === 'not') walk(c.child, path)
    if (c.kind === 'all' || c.kind === 'any') c.children.forEach((child) => walk(child, path))
  }
  walk(recipe.when, 'condition')
  recipe.actions.forEach((a, i) => {
    if (a.kind !== 'cap' || a.args === undefined || a.argUnits === undefined) return
    for (const [arg, unit] of Object.entries(a.argUnits)) {
      const value = a.args[arg]
      if (typeof value === 'number')
        notes.push({
          where: `action ${i + 1} ${a.cap}.${a.method}.${arg}`,
          value,
          unit,
        })
    }
  })
  return notes
}

function summarize(
  trigger: string,
  conditions: readonly ConditionAnswer[],
  actions: readonly ActionAnswer[],
  cooldown?: number,
): string[] {
  const lines = [trigger]
  for (const c of conditions) {
    const v =
      typeof c.value === 'object' && !Array.isArray(c.value)
        ? `${c.value.value} ${c.value.unit}`
        : JSON.stringify(c.value)
    lines.push(`  and device ${c.deviceId} ${c.cap}.${c.fieldPath} ${c.operator} ${v}`)
  }
  for (const a of actions) {
    if (a.kind === 'wait') lines.push(`  then wait ${a.seconds}s`)
    else {
      const ids = Array.isArray(a.deviceId) ? a.deviceId.join(', ') : String(a.deviceId)
      lines.push(
        `  then ${a.cap}.${a.method} on device ${ids}${a.args ? ` with ${JSON.stringify(a.args)}` : ''}`,
      )
    }
  }
  if (cooldown !== undefined) lines.push(`  at most once every ${cooldown} min`)
  return lines
}

export async function interviewAutomation(
  client: HubClient,
  answers: AutomationAnswers,
): Promise<AutomationInterview> {
  const t = answers.trigger
  if (t === undefined) {
    return need(
      [
        {
          field: 'trigger.kind',
          ask: 'What starts it?',
          choices: [
            {
              value: 'detection',
              label: 'a camera sees a person, vehicle, animal or package',
            },
            {
              value: 'device-state',
              label: 'a device value changes (a door opens, a temperature passes a limit…)',
            },
            { value: 'schedule', label: 'a time of day' },
          ],
        },
      ],
      [],
    )
  }
  const outcome = await buildTrigger(client, t)
  if (outcome.unavailable !== undefined)
    return { status: 'unavailable', reason: outcome.unavailable }
  if (outcome.trigger === undefined || outcome.summary === undefined) {
    return need(outcome.questions, outcome.problems)
  }
  const questions: Question[] = []
  const problems: Problem[] = []
  if (answers.conditions === undefined) questions.push(CONDITIONS_QUESTION)
  else {
    const checked = await checkConditions(client, answers.conditions)
    if (checked.unavailable !== undefined)
      return { status: 'unavailable', reason: checked.unavailable }
    problems.push(...checked.problems)
  }
  if ((answers.actions ?? []).length === 0) questions.push(ACTIONS_QUESTION)
  else {
    const checked = await checkActions(client, answers.actions ?? [])
    if (checked.unavailable !== undefined)
      return { status: 'unavailable', reason: checked.unavailable }
    problems.push(...checked.problems)
  }
  if (answers.name === undefined)
    questions.push({
      field: 'name',
      ask: 'What should the automation be called?',
    })
  if (questions.length > 0 || problems.length > 0) return need(questions, problems)

  const conditions = answers.conditions ?? []
  const actions = answers.actions ?? []
  const draft: AutomationRecipe = {
    when: convertLegacyWhen({ triggers: [outcome.trigger], conditions: toCondition(conditions) }),
    actions: toActions(actions),
    ...(answers.cooldownMinutes !== undefined
      ? {
          runMode: {
            mode: 'cooldown' as const,
            minutes: answers.cooldownMinutes,
          },
        }
      : {}),
  }
  const prepared = finishRecipe(draft)
  if (!prepared.ok) {
    return need(
      [conditions.length > 0 ? CONDITIONS_QUESTION : ACTIONS_QUESTION],
      [{ field: 'recipe', problem: prepared.error }],
    )
  }
  return {
    status: 'ready',
    name: answers.name ?? '',
    summary: summarize(outcome.summary, conditions, actions, answers.cooldownMinutes),
    recipe: prepared.recipe,
    quantities: quantityNotes(prepared.recipe),
    notes: [NO_CONDITIONS_NOTE],
    next: `Call ${SAVE_AUTOMATION_TOOL} with { name, recipe } for a preview, then again with the confirm_token to save it.`,
  }
}

type Finished =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly error: string }

/** Schema, bounds and the unit boundary — the same three checks the editor runs before it saves. */
export function finishRecipe(recipe: AutomationRecipe): Finished {
  const parsed = AutomationRecipeSchema.safeParse(recipe)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'the recipe is incomplete',
    }
  }
  const bounds = validateRecipeBounds(parsed.data)
  if (bounds !== null) return { ok: false, error: bounds }
  return prepareRecipeUnits(parsed.data, unitResolver())
}

export async function automationQuestionnaire(
  ctx: McpContext,
  answers: AutomationAnswers,
): Promise<AutomationInterview | NoSessionResult> {
  return withHub(ctx, ({ client }) => interviewAutomation(client, answers))
}

// ---------------------------------------------------------------------------
// save

export interface SaveAutomationArgs {
  readonly name: string
  readonly recipe: AutomationRecipe
  readonly enabled: boolean
}

const BlockRowSchema = z.looseObject({ name: z.string() })
const BlockListSchema = z.union([
  z.array(BlockRowSchema),
  z.looseObject({ blocks: z.array(BlockRowSchema) }),
])

function blockNames(list: z.infer<typeof BlockListSchema>): readonly string[] {
  return (Array.isArray(list) ? list : list.blocks).map((b) => b.name)
}

const BLOCK_PLACEMENT = 'hub'

export function saveAutomationSpec(client: HubClient): GatedToolSpec<SaveAutomationArgs> {
  return {
    tool: SAVE_AUTOMATION_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const finished = finishRecipe(args.recipe)
      if (!finished.ok) {
        return { confirmable: false, describe: { problem: finished.error } }
      }
      let code: string
      try {
        code = generateAutomationBlock({
          name: args.name,
          recipe: finished.recipe,
        })
      } catch (error: unknown) {
        return {
          confirmable: false,
          describe: {
            problem: error instanceof Error ? error.message : String(error),
          },
        }
      }
      const blocks = await readQuery(client, 'coreBlocks.list', {}, BlockListSchema)
      if (!blocks.ok) {
        return {
          confirmable: false,
          describe: {
            problem: `could not check existing automations: ${blocks.reason}`,
          },
        }
      }
      if (blockNames(blocks.value).includes(args.name)) {
        return {
          confirmable: false,
          describe: {
            problem: `an automation named "${args.name}" already exists — pick another name or edit it in the admin UI`,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'create automation',
          name: args.name,
          runsOn: 'the hub',
          enabled: args.enabled,
          effect: args.enabled
            ? 'it starts running as soon as it is saved'
            : 'it is saved switched off',
          rows: countWhenLeaves(finished.recipe.when),
          steps: finished.recipe.actions.length,
          quantities: quantityNotes(finished.recipe),
          generatedBytes: code.length,
        },
      }
    },
    async execute(args) {
      const finished = finishRecipe(args.recipe)
      if (!finished.ok) throw new Error(finished.error)
      const code = generateAutomationBlock({
        name: args.name,
        recipe: finished.recipe,
      })
      const created = await client.call('POST', 'coreBlocks.create', {
        block: {
          name: args.name,
          code,
          enabled: args.enabled,
          placement: BLOCK_PLACEMENT,
        },
      })
      return { created: true, block: created }
    },
  }
}

export async function saveAutomation(
  ctx: McpContext,
  args: SaveAutomationArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, saveAutomationSpec, args, confirmToken)
}

const GATE_HOW =
  'Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.'

export function registerAutomationTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_automation_questionnaire',
    'Interview for a new automation (a recipe: ONE `when` tree — events that start it, states that must hold — and the actions). Stateless: send every answer so far in `answers`; it returns the questions still open, with choices read from the hub, or `ready` with a summary and the recipe. A number on a quantity field is { value, unit }. Writes nothing.',
    { answers: AutomationAnswersSchema },
    async ({ answers }): Promise<ToolTextResult> =>
      text(await automationQuestionnaire(ctx, answers)),
  )
  server.tool(
    SAVE_AUTOMATION_TOOL,
    `Save an automation recipe (the \`recipe\` of a ready questionnaire) as a hub block. ${GATE_HOW}`,
    {
      name: z.string().min(1).max(120),
      recipe: AutomationRecipeSchema,
      enabled: z.boolean().default(true),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ name, recipe, enabled, confirm_token }): Promise<ToolTextResult> =>
      text(await saveAutomation(ctx, { name, recipe, enabled }, confirm_token)),
  )
}
