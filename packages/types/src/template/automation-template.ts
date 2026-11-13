/**
 * Automation templates (#527): the `automation` kind of the template store
 * (D963). A template is an automation BODY plus declared, typed INPUTS and the
 * BINDINGS that say where each input's value lands in the body. Creating an
 * automation from a template asks only for the inputs; the instance stores the
 * template id and the values (`AutomationRecipe.template`) and is EXPANDED into
 * an ordinary recipe — same codegen, same engine, same traces.
 *
 * The body is not a recipe until it is expanded (a choose with no branch yet,
 * a leaf with no device), so it is stored as JSON and judged only after the
 * expansion, by `AutomationRecipeSchema`.
 *
 * Bindings are paths into the body:
 *  - `value` writes one input's value at a path. Device, number, duration,
 *    text, select and boolean values REPLACE what is there (a device with
 *    `as: 'target'` becomes `{ kind: 'devices', ids }`); event and action values
 *    MERGE into the object at the path (a `device-fired` row, a command step).
 *  - `rows` appends one copy of `item` per row of a repeatable group to the list
 *    at the path, each copy filled by its own row-relative bindings; `row-id`
 *    writes `<group>-<index>`, so a row's event leaf and the branch that reads it
 *    (`triggered-by`) agree on one name.
 *
 * Everything here is pure: the admin UI expands on save and the hub re-expands
 * every instance when a template changes, with the same function.
 */
import { z } from 'zod'
import { findVocabAction } from '../device/cap-vocabulary/action-index.js'
import { AutomationRecipeSchema, type AutomationRecipe } from '../automation/recipe.js'
import {
  TemplateActionValueSchema,
  TemplateEventValueSchema,
  type TemplateGroupRow,
  type TemplateInputValue,
  type TemplateInputValues,
  type TemplateInstanceProblem,
  type TemplateScalarValue,
} from '../automation/template-link.js'

export const TEMPLATE_INPUT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const inputKey = z.string().regex(TEMPLATE_INPUT_KEY_RE)

const inputBase = {
  key: inputKey,
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  /** Absent means required. */
  optional: z.literal(true).optional(),
}

export const TemplateDeviceFilterSchema = z.object({
  /** Only devices that offer this capability. */
  capability: z.string().min(1).optional(),
  /** Only devices of this role / device type (`light`, `switch`, `button`). */
  role: z.string().min(1).optional(),
})
export type TemplateDeviceFilter = z.infer<typeof TemplateDeviceFilterSchema>

const DeviceInputSchema = z.object({
  kind: z.literal('device'),
  ...inputBase,
  multiple: z.literal(true).optional(),
  filter: TemplateDeviceFilterSchema.optional(),
})
const EventInputSchema = z.object({
  kind: z.literal('event'),
  ...inputBase,
  /** The device input (same level) whose event vocabulary is offered (D1044). */
  deviceInput: inputKey,
})
const ActionInputSchema = z.object({
  kind: z.literal('action'),
  ...inputBase,
  /** The device input (same level) whose actions are offered; absent offers all (D1050). */
  deviceInput: inputKey.optional(),
})
const NumberInputSchema = z.object({
  kind: z.literal('number'),
  ...inputBase,
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.number().optional(),
})
const DurationInputSchema = z.object({
  kind: z.literal('duration'),
  ...inputBase,
  /** Seconds. */
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
  default: z.number().nonnegative().optional(),
})
const TextInputSchema = z.object({
  kind: z.literal('text'),
  ...inputBase,
  maxLength: z.number().int().min(1).max(2000).optional(),
  default: z.string().optional(),
})
export const TemplateSelectOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1).max(80),
})
const SelectInputSchema = z.object({
  kind: z.literal('select'),
  ...inputBase,
  options: z.array(TemplateSelectOptionSchema).min(1).max(50),
  default: z.string().optional(),
})
const BooleanInputSchema = z.object({
  kind: z.literal('boolean'),
  ...inputBase,
  default: z.boolean().optional(),
})

export const TemplateScalarInputSchema = z.discriminatedUnion('kind', [
  DeviceInputSchema,
  EventInputSchema,
  ActionInputSchema,
  NumberInputSchema,
  DurationInputSchema,
  TextInputSchema,
  SelectInputSchema,
  BooleanInputSchema,
])
export type TemplateScalarInput = z.infer<typeof TemplateScalarInputSchema>

export const TEMPLATE_GROUP_ROWS_MAX = 20
const GroupInputSchema = z.object({
  kind: z.literal('group'),
  ...inputBase,
  inputs: z.array(TemplateScalarInputSchema).min(1).max(10),
  minRows: z.number().int().min(0).max(TEMPLATE_GROUP_ROWS_MAX).optional(),
  maxRows: z.number().int().min(1).max(TEMPLATE_GROUP_ROWS_MAX).optional(),
})
export type TemplateGroupInput = z.infer<typeof GroupInputSchema>

export const TemplateInputSchema = z.discriminatedUnion('kind', [
  ...TemplateScalarInputSchema.options,
  GroupInputSchema,
])
export type TemplateInput = z.infer<typeof TemplateInputSchema>
export type TemplateInputKind = TemplateInput['kind']

export const TemplatePathSchema = z
  .array(z.union([z.string().min(1), z.number().int().nonnegative()]))
  .max(24)
/** Keys and list indexes from the body (or a row item) root; empty is the root itself. */
export type TemplatePath = z.infer<typeof TemplatePathSchema>

export const TemplateValueBindingSchema = z.object({
  kind: z.literal('value'),
  input: inputKey,
  path: TemplatePathSchema,
  /** A device value written as a step target (`{ kind: 'devices', ids }`). */
  as: z.literal('target').optional(),
})
export type TemplateValueBinding = z.infer<typeof TemplateValueBindingSchema>

export const TemplateRowIdBindingSchema = z.object({
  kind: z.literal('row-id'),
  path: TemplatePathSchema,
})

export const TemplateRowItemBindingSchema = z.discriminatedUnion('kind', [
  TemplateValueBindingSchema,
  TemplateRowIdBindingSchema,
])
export type TemplateRowItemBinding = z.infer<typeof TemplateRowItemBindingSchema>

export const TemplateRowsBindingSchema = z.object({
  kind: z.literal('rows'),
  input: inputKey,
  /** The list in the body the rows are appended to. */
  path: TemplatePathSchema,
  /** The JSON copied once per row. */
  item: z.unknown(),
  bindings: z.array(TemplateRowItemBindingSchema).max(40),
})
export type TemplateRowsBinding = z.infer<typeof TemplateRowsBindingSchema>

export const TemplateBindingSchema = z.discriminatedUnion('kind', [
  TemplateValueBindingSchema,
  TemplateRowsBindingSchema,
])
export type TemplateBinding = z.infer<typeof TemplateBindingSchema>

export const AUTOMATION_TEMPLATE_VERSION = 1

function bindingProblems(
  payload: {
    readonly inputs: readonly TemplateInput[]
    readonly bindings: readonly TemplateBinding[]
  },
  ctx: z.RefinementCtx,
): void {
  const byKey = new Map<string, TemplateInput>()
  payload.inputs.forEach((input, index) => {
    if (byKey.has(input.key)) {
      ctx.addIssue({
        code: 'custom',
        message: `input "${input.key}" is declared twice`,
        path: ['inputs', index],
      })
    }
    byKey.set(input.key, input)
    const siblings = input.kind === 'group' ? input.inputs : payload.inputs
    for (const scalar of input.kind === 'group' ? input.inputs : [input]) {
      if (scalar.kind !== 'event' && scalar.kind !== 'action') continue
      if (scalar.deviceInput === undefined) continue
      const device = siblings.find((s) => s.key === scalar.deviceInput)
      if (device === undefined || device.kind !== 'device') {
        ctx.addIssue({
          code: 'custom',
          message: `"${scalar.key}" reads the device input "${scalar.deviceInput}", which is not a device input beside it`,
          path: ['inputs', index],
        })
      }
    }
  })
  payload.bindings.forEach((binding, index) => {
    const input = byKey.get(binding.input)
    if (input === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `binding names the undeclared input "${binding.input}"`,
        path: ['bindings', index],
      })
      return
    }
    if (binding.kind === 'value' && input.kind === 'group') {
      ctx.addIssue({
        code: 'custom',
        message: `group "${input.key}" is bound with rows, not a value`,
        path: ['bindings', index],
      })
    }
    if (binding.kind === 'rows') {
      if (input.kind !== 'group') {
        ctx.addIssue({
          code: 'custom',
          message: `rows need a group input, "${input.key}" is ${input.kind}`,
          path: ['bindings', index],
        })
        return
      }
      for (const row of binding.bindings) {
        if (row.kind === 'value' && !input.inputs.some((i) => i.key === row.input)) {
          ctx.addIssue({
            code: 'custom',
            message: `row binding names "${row.input}", which group "${input.key}" does not declare`,
            path: ['bindings', index],
          })
        }
      }
    }
  })
}

export const AutomationTemplatePayloadSchema = z
  .object({
    version: z.literal(AUTOMATION_TEMPLATE_VERSION),
    description: z.string().max(500).optional(),
    /** The automation body; a recipe once the inputs are written into it. */
    body: z.record(z.string(), z.unknown()),
    inputs: z.array(TemplateInputSchema).max(30),
    bindings: z.array(TemplateBindingSchema).max(100),
  })
  .superRefine(bindingProblems)
export type AutomationTemplatePayload = z.infer<typeof AutomationTemplatePayloadSchema>

// ── values ───────────────────────────────────────────────────────────────

function valueProblem(input: TemplateScalarInput, value: TemplateInputValue): string | null {
  switch (input.kind) {
    case 'device': {
      if (input.multiple === true) {
        return Array.isArray(value) &&
          value.length > 0 &&
          value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)
          ? null
          : 'pick at least one device'
      }
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? null
        : 'pick one device'
    }
    case 'event':
      return TemplateEventValueSchema.safeParse(value).success ? null : 'pick an event'
    case 'action': {
      const parsed = TemplateActionValueSchema.safeParse(value)
      if (!parsed.success) return 'pick an action'
      return findVocabAction(parsed.data.actionId) === undefined
        ? `"${parsed.data.actionId}" is not a vocabulary action`
        : null
    }
    case 'number':
    case 'duration': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'a number is required'
      if (input.min !== undefined && value < input.min) return `at least ${input.min}`
      if (input.max !== undefined && value > input.max) return `at most ${input.max}`
      return null
    }
    case 'text': {
      if (typeof value !== 'string') return 'text is required'
      return input.maxLength !== undefined && value.length > input.maxLength
        ? `at most ${input.maxLength} characters`
        : null
    }
    case 'select':
      return typeof value === 'string' && input.options.some((o) => o.value === value)
        ? null
        : 'pick one of the options'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'on or off'
  }
}

function defaultOf(input: TemplateScalarInput): TemplateScalarValue | undefined {
  switch (input.kind) {
    case 'number':
    case 'duration':
    case 'text':
    case 'select':
    case 'boolean':
      return input.default
    default:
      return undefined
  }
}

function isScalar(value: TemplateInputValue): value is TemplateScalarValue {
  return !(Array.isArray(value) && value.some((v) => typeof v === 'object' && v !== null))
}

function isRowList(value: TemplateInputValue): value is TemplateGroupRow[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  )
}

type ScalarValues = ReadonlyMap<string, TemplateScalarValue>

function resolveScalars(
  inputs: readonly TemplateScalarInput[],
  values: Readonly<Record<string, TemplateInputValue>>,
  prefix: string,
  problems: TemplateInstanceProblem[],
): Map<string, TemplateScalarValue> {
  const out = new Map<string, TemplateScalarValue>()
  for (const input of inputs) {
    const address = `${prefix}${input.key}`
    const raw = values[input.key] ?? defaultOf(input)
    if (raw === undefined) {
      if (input.optional !== true) {
        problems.push({
          code: 'missing-input',
          input: address,
          detail: `"${input.label}" is required`,
        })
      }
      continue
    }
    const problem = isScalar(raw) ? valueProblem(input, raw) : 'a single value is required'
    if (problem !== null || !isScalar(raw)) {
      problems.push({ code: 'invalid-input', input: address, detail: problem ?? 'invalid value' })
      continue
    }
    out.set(input.key, raw)
  }
  return out
}

interface ResolvedValues {
  readonly scalars: ScalarValues
  readonly groups: ReadonlyMap<string, readonly ScalarValues[]>
}

function resolveValues(
  payload: AutomationTemplatePayload,
  values: TemplateInputValues,
  problems: TemplateInstanceProblem[],
): ResolvedValues {
  const scalarInputs = payload.inputs.filter((i): i is TemplateScalarInput => i.kind !== 'group')
  const scalars = resolveScalars(scalarInputs, values, '', problems)
  const groups = new Map<string, ScalarValues[]>()
  for (const input of payload.inputs) {
    if (input.kind !== 'group') continue
    const raw = values[input.key] ?? []
    if (!isRowList(raw)) {
      problems.push({
        code: 'invalid-input',
        input: input.key,
        detail: 'a list of rows is required',
      })
      continue
    }
    const min = input.minRows ?? (input.optional === true ? 0 : 1)
    const max = input.maxRows ?? TEMPLATE_GROUP_ROWS_MAX
    if (raw.length < min) {
      problems.push({
        code: raw.length === 0 ? 'missing-input' : 'invalid-input',
        input: input.key,
        detail: `"${input.label}" needs at least ${min} row(s)`,
      })
      continue
    }
    if (raw.length > max) {
      problems.push({
        code: 'invalid-input',
        input: input.key,
        detail: `"${input.label}" takes at most ${max} row(s)`,
      })
      continue
    }
    groups.set(
      input.key,
      raw.map((row, index) =>
        resolveScalars(input.inputs, row, `${input.key}.${index}.`, problems),
      ),
    )
  }
  return { scalars, groups }
}

// ── writing into JSON, immutably ─────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class PathError extends Error {}

function getAt(root: unknown, path: TemplatePath): unknown {
  let node = root
  for (const segment of path) {
    if (typeof segment === 'number') node = Array.isArray(node) ? node[segment] : undefined
    else node = isRecord(node) ? node[segment] : undefined
  }
  return node
}

/** `root` with `value` at `path`; missing containers are created, a wrong one throws. */
function setAt(root: unknown, path: TemplatePath, value: unknown): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (typeof head === 'number') {
    const list = root === undefined ? [] : root
    if (!Array.isArray(list)) throw new PathError(`expected a list at index ${head}`)
    const next = [...list]
    next[head] = setAt(list[head], rest, value)
    return next
  }
  const object = root === undefined ? {} : root
  if (!isRecord(object)) throw new PathError(`expected an object at "${head}"`)
  return { ...object, [head]: setAt(object[head], rest, value) }
}

const EVENT_FIELDS = ['eventIds', 'sourceIds', 'kinds'] as const
const ACTION_FIELDS = ['actionId', 'args', 'argUnits'] as const

function mergeInto(
  current: unknown,
  drop: readonly string[],
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const base = isRecord(current) ? current : {}
  const kept = Object.fromEntries(Object.entries(base).filter(([k]) => !drop.includes(k)))
  return { ...kept, ...patch }
}

function writeValue(
  root: unknown,
  binding: TemplateValueBinding,
  input: TemplateScalarInput,
  value: TemplateScalarValue,
): unknown {
  switch (input.kind) {
    case 'event':
      return setAt(
        root,
        binding.path,
        mergeInto(getAt(root, binding.path), EVENT_FIELDS, TemplateEventValueSchema.parse(value)),
      )
    case 'action':
      return setAt(
        root,
        binding.path,
        mergeInto(getAt(root, binding.path), ACTION_FIELDS, TemplateActionValueSchema.parse(value)),
      )
    case 'device':
      if (binding.as === 'target') {
        const ids = Array.isArray(value) ? value : [value]
        return setAt(root, binding.path, { kind: 'devices', ids })
      }
      return setAt(root, binding.path, value)
    default:
      return setAt(root, binding.path, value)
  }
}

function applyRows(
  root: unknown,
  binding: TemplateRowsBinding,
  group: TemplateGroupInput,
  rows: readonly ScalarValues[],
): unknown {
  const existing = getAt(root, binding.path)
  const list = existing === undefined ? [] : existing
  if (!Array.isArray(list)) throw new PathError(`rows of "${group.key}" need a list`)
  const items = rows.map((row, index) => {
    let item: unknown = binding.item
    for (const rowBinding of binding.bindings) {
      if (rowBinding.kind === 'row-id') {
        item = setAt(item, rowBinding.path, `${group.key}-${index}`)
        continue
      }
      const input = group.inputs.find((i) => i.key === rowBinding.input)
      const value = row.get(rowBinding.input)
      if (input === undefined || value === undefined) continue
      item = writeValue(item, rowBinding, input, value)
    }
    return item
  })
  return setAt(root, binding.path, [...list, ...items])
}

// ── expansion ────────────────────────────────────────────────────────────

export type AutomationTemplateExpansion =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly problems: readonly TemplateInstanceProblem[] }

/** The body with the values written in, as a recipe — or every reason it is not one. */
export function expandAutomationTemplate(
  payload: AutomationTemplatePayload,
  values: TemplateInputValues,
): AutomationTemplateExpansion {
  const problems: TemplateInstanceProblem[] = []
  const resolved = resolveValues(payload, values, problems)
  if (problems.length > 0) return { ok: false, problems }
  let body: unknown = payload.body
  try {
    for (const binding of payload.bindings) {
      const input = payload.inputs.find((i) => i.key === binding.input)
      if (input === undefined) continue
      if (binding.kind === 'rows') {
        if (input.kind !== 'group') continue
        body = applyRows(body, binding, input, resolved.groups.get(input.key) ?? [])
        continue
      }
      if (input.kind === 'group') continue
      const value = resolved.scalars.get(input.key)
      if (value === undefined) continue
      body = writeValue(body, binding, input, value)
    }
  } catch (error: unknown) {
    if (!(error instanceof PathError)) throw error
    return { ok: false, problems: [{ code: 'invalid-recipe', detail: error.message }] }
  }
  const parsed = AutomationRecipeSchema.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 5).map((issue) => ({
        code: 'invalid-recipe',
        detail: `${issue.path.join('.')}: ${issue.message}`,
      })),
    }
  }
  const { template: _ignored, ...recipe } = parsed.data
  return { ok: true, recipe }
}

/** A new instance: the expansion, linked to its template. */
export function instantiateAutomationTemplate(
  templateId: string,
  payload: AutomationTemplatePayload,
  values: TemplateInputValues,
): AutomationTemplateExpansion {
  const expanded = expandAutomationTemplate(payload, values)
  if (!expanded.ok) return expanded
  return { ok: true, recipe: { ...expanded.recipe, template: { templateId, values } } }
}

export interface AutomationInstanceReexpansion {
  readonly recipe: AutomationRecipe
  /** True when the values no longer fit and the previous body was kept. */
  readonly flagged: boolean
}

/**
 * An instance after its template changed (or vanished, `payload === null`):
 * re-expanded when its values still fit, otherwise its previous body kept and
 * the link flagged with the problems. Never dropped.
 */
export function reexpandAutomationInstance(
  payload: AutomationTemplatePayload | null,
  current: AutomationRecipe,
): AutomationInstanceReexpansion {
  const link = current.template
  if (link === undefined) return { recipe: current, flagged: false }
  const expanded: AutomationTemplateExpansion =
    payload === null
      ? {
          ok: false,
          problems: [{ code: 'missing-template', detail: `template "${link.templateId}" is gone` }],
        }
      : expandAutomationTemplate(payload, link.values)
  if (expanded.ok) {
    return {
      recipe: {
        ...expanded.recipe,
        template: { templateId: link.templateId, values: link.values },
      },
      flagged: false,
    }
  }
  const [first, ...rest] = expanded.problems
  if (first === undefined) return { recipe: current, flagged: false }
  return {
    recipe: { ...current, template: { ...link, problems: [first, ...rest] } },
    flagged: true,
  }
}

/** "Convert to a free automation": the expansion as it is, without the link. */
export function detachAutomationInstance(recipe: AutomationRecipe): AutomationRecipe {
  const { template: _link, ...free } = recipe
  return free
}

// ── export (versioned JSON; import is #528) ─────────────────────────────

export const AUTOMATION_TEMPLATE_EXPORT_FORMAT = 'camstack.automation-template'
export const AutomationTemplateExportSchema = z.object({
  format: z.literal(AUTOMATION_TEMPLATE_EXPORT_FORMAT),
  version: z.literal(AUTOMATION_TEMPLATE_VERSION),
  name: z.string().min(1).max(120),
  payload: AutomationTemplatePayloadSchema,
})
export type AutomationTemplateExport = z.infer<typeof AutomationTemplateExportSchema>

export function exportAutomationTemplate(
  name: string,
  payload: AutomationTemplatePayload,
): AutomationTemplateExport {
  return {
    format: AUTOMATION_TEMPLATE_EXPORT_FORMAT,
    version: AUTOMATION_TEMPLATE_VERSION,
    name,
    payload,
  }
}
