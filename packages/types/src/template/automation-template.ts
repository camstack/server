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
 * A group row may hold one more level of groups (a button row with a list of
 * events and a list of commands). Three bindings reach that level:
 *  - a `rows` binding INSIDE a row's bindings appends one copy of its item per
 *    nested row, at a path relative to the parent row's item (a branch's steps);
 *  - a top-level `rows` binding with `nested` appends one item per nested row of
 *    EVERY row, flat (one event leaf per event of every button);
 *  - `row-ids` writes the ids of a row's nested rows
 *    (`<group>-<index>-<nested>-<index>`), the same ids `row-id` gives those
 *    nested rows, so a branch can name every leaf of its row.
 *
 * A `time-window` input is an optional limit on WHEN the automation may run. Its
 * `gate` binding wraps the tree at a path as `all[time-is, <that tree>]`; left
 * without a value the tree is not touched at all. A gate is declared after the
 * bindings that write into the tree it wraps, because it moves that tree one
 * level down.
 *
 * Everything here is pure: the admin UI expands on save and the hub re-expands
 * every instance when a template changes, with the same function.
 */
import { z } from 'zod'
import { findVocabAction } from '../device/cap-vocabulary/action-index.js'
import {
  AutomationBranchStepSchema,
  AutomationRecipeSchema,
  type AutomationRecipe,
} from '../automation/recipe.js'
import { AutomationWhenSchema, EVENT_LEAF_ID_RE } from '../automation/when.js'
import {
  TemplateActionValueSchema,
  TemplateEntriesValueSchema,
  TemplateEventValueSchema,
  TemplateTimeWindowValueSchema,
  type TemplateEntry,
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

/** A limit on when the automation may run; only a `gate` binding reads it. */
const TimeWindowInputSchema = z.object({
  kind: z.literal('time-window'),
  ...inputBase,
})

export const TEMPLATE_ENTRIES_MAX = 20
/**
 * A list of automation elements, verbatim: `trigger` entries are event leaves
 * of a `when` tree (`device-fired`), `step` entries are steps of a branch
 * (`command`, `wait`). `allow` names the kinds the list takes; each entry is
 * judged by the automation's own schema, then by `allow`.
 */
const EntriesInputSchema = z.object({
  kind: z.literal('entries'),
  ...inputBase,
  entry: z.enum(['trigger', 'step']),
  allow: z.array(z.string().min(1)).min(1).max(10),
  maxItems: z.number().int().min(1).max(TEMPLATE_ENTRIES_MAX).optional(),
})

export const TemplateScalarInputSchema = z.discriminatedUnion('kind', [
  EntriesInputSchema,
  DeviceInputSchema,
  EventInputSchema,
  ActionInputSchema,
  NumberInputSchema,
  DurationInputSchema,
  TextInputSchema,
  SelectInputSchema,
  BooleanInputSchema,
  TimeWindowInputSchema,
])
export type TemplateScalarInput = z.infer<typeof TemplateScalarInputSchema>

export const TEMPLATE_GROUP_ROWS_MAX = 20
const groupBase = {
  kind: z.literal('group'),
  ...inputBase,
  /** What one row is, in the singular and lower case ("button"): "Add button". */
  rowLabel: z.string().min(1).max(40).optional(),
  minRows: z.number().int().min(0).max(TEMPLATE_GROUP_ROWS_MAX).optional(),
  maxRows: z.number().int().min(1).max(TEMPLATE_GROUP_ROWS_MAX).optional(),
}
/** A group inside a group row: its rows hold values only, never another group. */
const NestedGroupInputSchema = z.object({
  ...groupBase,
  inputs: z.array(TemplateScalarInputSchema).min(1).max(10),
})
export type TemplateNestedGroupInput = z.infer<typeof NestedGroupInputSchema>

export const TemplateRowInputSchema = z.discriminatedUnion('kind', [
  ...TemplateScalarInputSchema.options,
  NestedGroupInputSchema,
])
/** What a group row may hold: a value, or one more level of rows. */
export type TemplateRowInput = z.infer<typeof TemplateRowInputSchema>

const GroupInputSchema = z.object({
  ...groupBase,
  inputs: z.array(TemplateRowInputSchema).min(1).max(10),
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

/**
 * Appends an `entries` input's elements, verbatim, to the list at `path`. In a
 * row's bindings `input` is the row's own entries input and `path` is from the
 * row's item; at the top level, with `in`, it appends the `input` entries of
 * EVERY row of the group `in` (all buttons' triggers into one `when`), and
 * without `in` it appends a top-level entries input.
 */
export const TemplateEntriesBindingSchema = z.object({
  kind: z.literal('entries'),
  input: inputKey,
  path: TemplatePathSchema,
  in: inputKey.optional(),
})
export type TemplateEntriesBinding = z.infer<typeof TemplateEntriesBindingSchema>

/** What fills the item of a row that holds values only. */
export const TemplateLeafRowBindingSchema = z.discriminatedUnion('kind', [
  TemplateValueBindingSchema,
  TemplateRowIdBindingSchema,
])
export type TemplateLeafRowBinding = z.infer<typeof TemplateLeafRowBindingSchema>

/** The ids of a row's nested rows, as a list (a branch that reads every leaf of its row). */
export const TemplateRowIdsBindingSchema = z.object({
  kind: z.literal('row-ids'),
  /** The nested group whose rows are named. */
  input: inputKey,
  path: TemplatePathSchema,
})

/** One copy of `item` per nested row, appended inside the parent row's item. */
export const TemplateNestedRowsBindingSchema = z.object({
  kind: z.literal('rows'),
  /** The nested group, declared by the parent row's group. */
  input: inputKey,
  /** The list the nested rows are appended to, from the parent row's item. */
  path: TemplatePathSchema,
  item: z.unknown(),
  bindings: z.array(TemplateLeafRowBindingSchema).max(40),
})
export type TemplateNestedRowsBinding = z.infer<typeof TemplateNestedRowsBindingSchema>

export const TemplateRowItemBindingSchema = z.discriminatedUnion('kind', [
  TemplateValueBindingSchema,
  TemplateEntriesBindingSchema,
  TemplateRowIdBindingSchema,
  TemplateRowIdsBindingSchema,
  TemplateNestedRowsBindingSchema,
])
export type TemplateRowItemBinding = z.infer<typeof TemplateRowItemBindingSchema>

export const TemplateRowsBindingSchema = z.object({
  kind: z.literal('rows'),
  input: inputKey,
  /**
   * A group the rows of `input` hold: the binding then appends one item per
   * NESTED row of every row, and its bindings read the nested row.
   */
  nested: inputKey.optional(),
  /** The list in the body the rows are appended to. */
  path: TemplatePathSchema,
  /** The JSON copied once per row. */
  item: z.unknown(),
  bindings: z.array(TemplateRowItemBindingSchema).max(40),
})
export type TemplateRowsBinding = z.infer<typeof TemplateRowsBindingSchema>

/** Wraps the condition tree at `path` as `all[time-is, <tree>]` when the input has a value. */
export const TemplateGateBindingSchema = z.object({
  kind: z.literal('gate'),
  /** A top-level `time-window` input. */
  input: inputKey,
  path: TemplatePathSchema,
})
export type TemplateGateBinding = z.infer<typeof TemplateGateBindingSchema>

export const TemplateBindingSchema = z.discriminatedUnion('kind', [
  TemplateValueBindingSchema,
  TemplateEntriesBindingSchema,
  TemplateRowsBindingSchema,
  TemplateGateBindingSchema,
])
export type TemplateBinding = z.infer<typeof TemplateBindingSchema>

export const AUTOMATION_TEMPLATE_VERSION = 1

interface BindingIssue {
  readonly message: string
  readonly path: readonly (string | number)[]
}

function scalarsOf(
  inputs: readonly (TemplateInput | TemplateRowInput)[],
): readonly TemplateScalarInput[] {
  return inputs.filter((input): input is TemplateScalarInput => input.kind !== 'group')
}

/** Twice-declared keys and event / action inputs that read no device beside them. */
function levelProblems(
  inputs: readonly (TemplateInput | TemplateRowInput)[],
  path: readonly (string | number)[],
  inRow = false,
): readonly BindingIssue[] {
  const issues: BindingIssue[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    if (seen.has(input.key)) {
      issues.push({ message: `input "${input.key}" is declared twice`, path })
    }
    seen.add(input.key)
    if (input.kind === 'group') {
      issues.push(...levelProblems(input.inputs, path, true))
      continue
    }
    if (input.kind === 'time-window' && inRow) {
      issues.push({
        message: `time window "${input.key}" limits the whole automation: it is not a row input`,
        path,
      })
    }
    if (input.kind !== 'event' && input.kind !== 'action') continue
    if (input.deviceInput === undefined) continue
    const device = inputs.find((sibling) => sibling.key === input.deviceInput)
    if (device === undefined || device.kind !== 'device') {
      issues.push({
        message: `"${input.key}" reads the device input "${input.deviceInput}", which is not a device input beside it`,
        path,
      })
    }
  }
  return issues
}

function nestedGroupOf(
  group: TemplateGroupInput,
  key: string,
): TemplateNestedGroupInput | undefined {
  const found = group.inputs.find((input) => input.key === key)
  return found !== undefined && found.kind === 'group' ? found : undefined
}

function leafBindingProblems(
  bindings: readonly TemplateRowItemBinding[],
  owner: TemplateGroupInput | TemplateNestedGroupInput,
): readonly string[] {
  const issues: string[] = []
  for (const row of bindings) {
    if (row.kind === 'row-id') continue
    if (row.kind === 'value') {
      const input = owner.inputs.find((i) => i.key === row.input)
      if (input === undefined) {
        issues.push(`row binding names "${row.input}", which group "${owner.key}" does not declare`)
      } else if (input.kind === 'group') {
        issues.push(`group "${input.key}" is bound with rows, not a value`)
      } else if (input.kind === 'entries') {
        issues.push(`entries "${input.key}" are bound with entries, not a value`)
      }
      continue
    }
    const nested = owner.inputs.find((i) => i.key === row.input)
    if (row.kind === 'entries') {
      if (nested === undefined || nested.kind !== 'entries') {
        issues.push(`"${row.input}" is not an entries input inside "${owner.key}"`)
      }
      continue
    }
    if (row.kind === 'row-ids') {
      if (nested === undefined || (nested.kind !== 'group' && nested.kind !== 'entries')) {
        issues.push(`"${row.input}" is not a group or entries input inside "${owner.key}"`)
      }
      continue
    }
    if (nested === undefined || nested.kind !== 'group') {
      issues.push(`"${row.input}" is not a group inside "${owner.key}"`)
      continue
    }
    issues.push(...leafBindingProblems(row.bindings, nested))
  }
  return issues
}

function rowsBindingProblems(
  binding: TemplateRowsBinding,
  group: TemplateGroupInput,
): readonly string[] {
  if (binding.nested === undefined) return leafBindingProblems(binding.bindings, group)
  const nested = nestedGroupOf(group, binding.nested)
  if (nested === undefined) {
    return [`"${binding.nested}" is not a group inside "${group.key}"`]
  }
  return leafBindingProblems(binding.bindings, nested)
}

function bindingProblems(
  payload: {
    readonly inputs: readonly TemplateInput[]
    readonly bindings: readonly TemplateBinding[]
  },
  ctx: z.RefinementCtx,
): void {
  const byKey = new Map<string, TemplateInput>()
  for (const input of payload.inputs) byKey.set(input.key, input)
  for (const issue of levelProblems(payload.inputs, ['inputs'])) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      path: [...issue.path],
    })
  }
  payload.bindings.forEach((binding, index) => {
    if (binding.kind === 'entries' && binding.in !== undefined) {
      const group = byKey.get(binding.in)
      const entries =
        group !== undefined && group.kind === 'group'
          ? group.inputs.find((i) => i.key === binding.input)
          : undefined
      if (entries === undefined || entries.kind !== 'entries') {
        ctx.addIssue({
          code: 'custom',
          message: `"${binding.input}" is not an entries input inside the group "${binding.in}"`,
          path: ['bindings', index],
        })
      }
      return
    }
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
    if ((binding.kind === 'entries') !== (input.kind === 'entries') && binding.kind !== 'rows') {
      if (binding.kind === 'entries' || binding.kind === 'value') {
        ctx.addIssue({
          code: 'custom',
          message:
            binding.kind === 'entries'
              ? `entries bindings read an entries input: "${input.key}" is ${input.kind}`
              : `entries "${input.key}" are bound with entries, not a value`,
          path: ['bindings', index],
        })
      }
    }
    if ((binding.kind === 'gate') !== (input.kind === 'time-window')) {
      ctx.addIssue({
        code: 'custom',
        message: `a gate reads a time window and a time window is bound with a gate: "${input.key}" is ${input.kind}`,
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
      for (const message of rowsBindingProblems(binding, input)) {
        ctx.addIssue({ code: 'custom', message, path: ['bindings', index] })
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
    case 'time-window': {
      const parsed = TemplateTimeWindowValueSchema.safeParse(value)
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'pick a time window')
    }
    case 'entries':
      return entriesProblem(input, value)
  }
}

/** Each entry is judged by the automation's own schema, then by the kinds the input allows. */
function entriesProblem(
  input: Extract<TemplateScalarInput, { kind: 'entries' }>,
  value: TemplateInputValue,
): string | null {
  const list = TemplateEntriesValueSchema.safeParse(value)
  if (!list.success) return 'a list of entries is required'
  if (list.data.length === 0) return 'add at least one'
  if (input.maxItems !== undefined && list.data.length > input.maxItems) {
    return `at most ${input.maxItems}`
  }
  for (const entry of list.data) {
    const parsed =
      input.entry === 'trigger'
        ? AutomationWhenSchema.safeParse(entry)
        : AutomationBranchStepSchema.safeParse(entry)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'an entry is not valid'
    if (!input.allow.includes(parsed.data.kind)) {
      return `"${parsed.data.kind}" is not allowed here`
    }
  }
  return null
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

/** One level of values, judged: its own values and the rows of each group it holds. */
interface ResolvedLevel {
  readonly scalars: ScalarValues
  readonly groups: ReadonlyMap<string, readonly ResolvedLevel[]>
}

type LevelValues = Readonly<Record<string, TemplateInputValue>>
type LevelGroup = TemplateGroupInput | TemplateNestedGroupInput

function resolveScalars(
  inputs: readonly TemplateScalarInput[],
  values: LevelValues,
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
    const problem =
      input.kind === 'entries' || isScalar(raw)
        ? valueProblem(input, raw)
        : 'a single value is required'
    if (problem !== null) {
      problems.push({
        code: 'invalid-input',
        input: address,
        detail: problem,
      })
      continue
    }
    if (input.kind === 'entries') {
      out.set(input.key, TemplateEntriesValueSchema.parse(raw))
    } else if (isScalar(raw)) {
      out.set(input.key, raw)
    }
  }
  return out
}

/** The rows of one group, each resolved; `null` when the list itself is refused. */
function resolveRows(
  group: LevelGroup,
  values: LevelValues,
  prefix: string,
  problems: TemplateInstanceProblem[],
): readonly ResolvedLevel[] | null {
  const address = `${prefix}${group.key}`
  const raw = values[group.key] ?? []
  if (!isRowList(raw)) {
    problems.push({
      code: 'invalid-input',
      input: address,
      detail: 'a list of rows is required',
    })
    return null
  }
  const min = group.minRows ?? (group.optional === true ? 0 : 1)
  const max = group.maxRows ?? TEMPLATE_GROUP_ROWS_MAX
  if (raw.length < min) {
    problems.push({
      code: raw.length === 0 ? 'missing-input' : 'invalid-input',
      input: address,
      detail: `"${group.label}" needs at least ${min} row(s)`,
    })
    return null
  }
  if (raw.length > max) {
    problems.push({
      code: 'invalid-input',
      input: address,
      detail: `"${group.label}" takes at most ${max} row(s)`,
    })
    return null
  }
  return raw.map((row, index) => resolveLevel(group.inputs, row, `${address}.${index}.`, problems))
}

function resolveLevel(
  inputs: readonly (TemplateInput | TemplateRowInput)[],
  values: LevelValues,
  prefix: string,
  problems: TemplateInstanceProblem[],
): ResolvedLevel {
  const scalars = resolveScalars(scalarsOf(inputs), values, prefix, problems)
  const groups = new Map<string, readonly ResolvedLevel[]>()
  for (const input of inputs) {
    if (input.kind !== 'group') continue
    const rows = resolveRows(input, values, prefix, problems)
    if (rows !== null) groups.set(input.key, rows)
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

/** The tree at the path, under an `all` beside the window. */
function writeGate(
  root: unknown,
  binding: TemplateGateBinding,
  value: TemplateScalarValue,
): unknown {
  const window = TemplateTimeWindowValueSchema.parse(value)
  return setAt(root, binding.path, {
    kind: 'all',
    children: [{ kind: 'time-is', ...window }, getAt(root, binding.path)],
  })
}

/** The name a row is known by: `buttons-0`, and `buttons-0-events-1` for a nested row. */
function rowIdOf(parentId: string | null, groupKey: string, index: number): string {
  const own = `${groupKey}-${index}`
  return parentId === null ? own : `${parentId}-${own}`
}

function appendAt(
  root: unknown,
  path: TemplatePath,
  items: readonly unknown[],
  key: string,
): unknown {
  const existing = getAt(root, path)
  const list = existing === undefined ? [] : existing
  if (!Array.isArray(list)) throw new PathError(`rows of "${key}" need a list`)
  return setAt(root, path, [...list, ...items])
}

/** The entries a row holds under `key`, each trigger carrying the leaf id the `triggered-by` of its row reads. */
function entriesOf(
  row: ResolvedLevel,
  input: Extract<TemplateRowInput, { kind: 'entries' }>,
  rowId: string,
): readonly TemplateEntry[] {
  const value = row.scalars.get(input.key)
  const parsed = TemplateEntriesValueSchema.safeParse(value)
  const entries = parsed.success ? parsed.data : []
  if (input.entry !== 'trigger') return entries
  return entries.map((entry, index) => {
    const id = Reflect.get(entry, 'id')
    const named = typeof id === 'string' && EVENT_LEAF_ID_RE.test(id)
    return named ? entry : { ...entry, id: rowIdOf(rowId, input.key, index) }
  })
}

/** One row's item: the template JSON with the row's values, ids and nested rows written in. */
function fillItem(
  template: unknown,
  bindings: readonly TemplateRowItemBinding[],
  group: LevelGroup,
  row: ResolvedLevel,
  rowId: string,
): unknown {
  let item = template
  for (const binding of bindings) {
    if (binding.kind === 'row-id') {
      item = setAt(item, binding.path, rowId)
      continue
    }
    if (binding.kind === 'value') {
      const input = group.inputs.find((i) => i.key === binding.input)
      const value = row.scalars.get(binding.input)
      if (input === undefined || input.kind === 'group' || value === undefined) continue
      item = writeValue(item, binding, input, value)
      continue
    }
    const nested = group.inputs.find((i) => i.key === binding.input)
    if (binding.kind === 'entries') {
      if (nested === undefined || nested.kind !== 'entries') continue
      item = appendAt(item, binding.path, entriesOf(row, nested, rowId), nested.key)
      continue
    }
    if (binding.kind === 'row-ids' && nested !== undefined && nested.kind === 'entries') {
      item = setAt(
        item,
        binding.path,
        entriesOf(row, nested, rowId).map((entry) => Reflect.get(entry, 'id')),
      )
      continue
    }
    if (nested === undefined || nested.kind !== 'group') continue
    const nestedRows = row.groups.get(nested.key) ?? []
    if (binding.kind === 'row-ids') {
      item = setAt(
        item,
        binding.path,
        nestedRows.map((_, index) => rowIdOf(rowId, nested.key, index)),
      )
      continue
    }
    item = appendAt(
      item,
      binding.path,
      nestedRows.map((nestedRow, index) =>
        fillItem(
          binding.item,
          binding.bindings,
          nested,
          nestedRow,
          rowIdOf(rowId, nested.key, index),
        ),
      ),
      nested.key,
    )
  }
  return item
}

function applyRows(
  root: unknown,
  binding: TemplateRowsBinding,
  group: TemplateGroupInput,
  rows: readonly ResolvedLevel[],
): unknown {
  if (binding.nested === undefined) {
    const items = rows.map((row, index) =>
      fillItem(binding.item, binding.bindings, group, row, rowIdOf(null, group.key, index)),
    )
    return appendAt(root, binding.path, items, group.key)
  }
  const nested = nestedGroupOf(group, binding.nested)
  if (nested === undefined) return root
  const items = rows.flatMap((row, index) =>
    (row.groups.get(nested.key) ?? []).map((nestedRow, nestedIndex) =>
      fillItem(
        binding.item,
        binding.bindings,
        nested,
        nestedRow,
        rowIdOf(rowIdOf(null, group.key, index), nested.key, nestedIndex),
      ),
    ),
  )
  return appendAt(root, binding.path, items, nested.key)
}

/** The `input` entries of EVERY row of the group `binding.in`, concatenated onto the list at the path. */
function applyEntriesOfRows(
  root: unknown,
  binding: TemplateEntriesBinding,
  inputs: readonly TemplateInput[],
  resolved: ResolvedLevel,
): unknown {
  const group = inputs.find((i) => i.key === binding.in)
  if (group === undefined || group.kind !== 'group') return root
  const entries = group.inputs.find((i) => i.key === binding.input)
  if (entries === undefined || entries.kind !== 'entries') return root
  const items = (resolved.groups.get(group.key) ?? []).flatMap((row, index) =>
    entriesOf(row, entries, rowIdOf(null, group.key, index)),
  )
  return appendAt(root, binding.path, items, entries.key)
}

// ── expansion ────────────────────────────────────────────────────────────

export type AutomationTemplateExpansion =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | {
      readonly ok: false
      readonly problems: readonly TemplateInstanceProblem[]
    }

/** The body with the values written in, as a recipe — or every reason it is not one. */
export function expandAutomationTemplate(
  payload: AutomationTemplatePayload,
  values: TemplateInputValues,
): AutomationTemplateExpansion {
  const problems: TemplateInstanceProblem[] = []
  const resolved = resolveLevel(payload.inputs, values, '', problems)
  if (problems.length > 0) return { ok: false, problems }
  let body: unknown = payload.body
  try {
    for (const binding of payload.bindings) {
      if (binding.kind === 'entries' && binding.in !== undefined) {
        body = applyEntriesOfRows(body, binding, payload.inputs, resolved)
        continue
      }
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
      if (binding.kind === 'entries') {
        const list = TemplateEntriesValueSchema.safeParse(value)
        if (list.success) body = appendAt(body, binding.path, list.data, input.key)
        continue
      }
      body =
        binding.kind === 'gate'
          ? writeGate(body, binding, value)
          : writeValue(body, binding, input, value)
    }
  } catch (error: unknown) {
    if (!(error instanceof PathError)) throw error
    return {
      ok: false,
      problems: [{ code: 'invalid-recipe', detail: error.message }],
    }
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
  return {
    ok: true,
    recipe: { ...expanded.recipe, template: { templateId, values } },
  }
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
          problems: [
            {
              code: 'missing-template',
              detail: `template "${link.templateId}" is gone`,
            },
          ],
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
