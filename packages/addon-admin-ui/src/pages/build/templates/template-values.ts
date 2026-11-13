/**
 * The values of an automation made from a template (#527), as the inputs form
 * edits them, and the one boundary that turns them into a saved block.
 *
 * Pure: the form holds `TemplateInputValues`; this file builds the starting
 * values, edits a row of a repeatable group, finds the problems of one input
 * by its dotted address, and expands values into the block the hub stores.
 */
import {
  type AutomationRecipe,
  type AutomationTemplatePayload,
  type CoreBlockInput,
  detachAutomationInstance,
  generateAutomationBlock,
  instantiateAutomationTemplate,
  TEMPLATE_GROUP_ROWS_MAX,
  type TemplateGroupInput,
  type TemplateGroupRow,
  type TemplateInput,
  type TemplateInputValue,
  type TemplateInputValues,
  type TemplateInstanceProblem,
  type TemplateScalarInput,
  type TemplateScalarValue,
} from '@camstack/types'
import { prepareRecipeUnits } from '../automation/recipe-units'

/** Blocks run on the hub only: an automation offers no placement choice. */
const HUB = 'hub'

function scalarDefault(input: TemplateScalarInput): TemplateScalarValue | undefined {
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

/** The row a group starts with: only the defaults its inputs declare. */
export function blankRow(group: TemplateGroupInput): TemplateGroupRow {
  const row: Record<string, TemplateScalarValue> = {}
  for (const input of group.inputs) {
    const value = scalarDefault(input)
    if (value !== undefined) row[input.key] = value
  }
  return row
}

export function groupBounds(group: TemplateGroupInput): {
  readonly min: number
  readonly max: number
} {
  return {
    min: group.minRows ?? (group.optional === true ? 0 : 1),
    max: group.maxRows ?? TEMPLATE_GROUP_ROWS_MAX,
  }
}

/** Values for a new automation: each input's default, each group at its minimum rows. */
export function initialValues(payload: AutomationTemplatePayload): TemplateInputValues {
  const values: Record<string, TemplateInputValue> = {}
  for (const input of payload.inputs) {
    if (input.kind === 'group') {
      values[input.key] = Array.from({ length: groupBounds(input).min }, () => blankRow(input))
      continue
    }
    const value = scalarDefault(input)
    if (value !== undefined) values[input.key] = value
  }
  return values
}

export function withValue(
  values: TemplateInputValues,
  key: string,
  value: TemplateInputValue | undefined,
): TemplateInputValues {
  const { [key]: _dropped, ...rest } = values
  return value === undefined ? rest : { ...rest, [key]: value }
}

/** Several keys at once (a command writes its devices and its action together). */
export type TemplateValuePatch = Readonly<Record<string, TemplateScalarValue | undefined>>

export function withValues(
  values: TemplateInputValues,
  patch: TemplateValuePatch,
): TemplateInputValues {
  let next = values
  for (const [key, value] of Object.entries(patch)) {
    next = withValue(next, key, value)
  }
  return next
}

export function rowsOf(values: TemplateInputValues, key: string): readonly TemplateGroupRow[] {
  const raw = values[key]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is TemplateGroupRow => typeof v === 'object' && v !== null && !Array.isArray(v),
  )
}

export function withRowValue(
  values: TemplateInputValues,
  groupKey: string,
  index: number,
  key: string,
  value: TemplateScalarValue | undefined,
): TemplateInputValues {
  const rows = rowsOf(values, groupKey).map((row, i) => {
    if (i !== index) return row
    const { [key]: _dropped, ...rest } = row
    return value === undefined ? rest : { ...rest, [key]: value }
  })
  return { ...values, [groupKey]: rows }
}

export function withRowValues(
  values: TemplateInputValues,
  groupKey: string,
  index: number,
  patch: TemplateValuePatch,
): TemplateInputValues {
  let next = values
  for (const [key, value] of Object.entries(patch)) {
    next = withRowValue(next, groupKey, index, key, value)
  }
  return next
}

export function withAddedRow(
  values: TemplateInputValues,
  group: TemplateGroupInput,
): TemplateInputValues {
  const rows = rowsOf(values, group.key)
  if (rows.length >= groupBounds(group).max) return values
  return { ...values, [group.key]: [...rows, blankRow(group)] }
}

export function withoutRow(
  values: TemplateInputValues,
  group: TemplateGroupInput,
  index: number,
): TemplateInputValues {
  const rows = rowsOf(values, group.key)
  if (rows.length <= groupBounds(group).min) return values
  return { ...values, [group.key]: rows.filter((_, i) => i !== index) }
}

/** Problems that name `address` exactly (`buttons.2.targets`) — shown under that input. */
export function problemsAt(
  problems: readonly TemplateInstanceProblem[],
  address: string,
): readonly TemplateInstanceProblem[] {
  return problems.filter((p) => p.input === address)
}

/** Problems that name no input of the form (a whole-recipe problem, a gone template). */
export function wholeProblems(
  problems: readonly TemplateInstanceProblem[],
  inputs: readonly TemplateInput[],
): readonly TemplateInstanceProblem[] {
  const roots = new Set(inputs.map((i) => i.key))
  return problems.filter((p) => p.input === undefined || !roots.has(p.input.split('.')[0] ?? ''))
}

export type InstanceBlock =
  | { readonly ok: true; readonly input: CoreBlockInput; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly problems: readonly TemplateInstanceProblem[] }

function blockOf(name: string, recipe: AutomationRecipe, enabled: boolean): InstanceBlock {
  const prepared = prepareRecipeUnits(recipe)
  if (!prepared.ok) {
    return { ok: false, problems: [{ code: 'invalid-recipe', detail: prepared.error }] }
  }
  try {
    return {
      ok: true,
      recipe: prepared.recipe,
      input: {
        name,
        code: generateAutomationBlock({ name, recipe: prepared.recipe }),
        enabled,
        placement: HUB,
      },
    }
  } catch (error: unknown) {
    return {
      ok: false,
      problems: [
        { code: 'invalid-recipe', detail: error instanceof Error ? error.message : String(error) },
      ],
    }
  }
}

/** The values expanded into the block that is saved, or every reason they cannot be. */
export function expandInstance(
  templateId: string,
  payload: AutomationTemplatePayload,
  values: TemplateInputValues,
  name: string,
  enabled: boolean,
): InstanceBlock {
  const expanded = instantiateAutomationTemplate(templateId, payload, values)
  if (!expanded.ok) return expanded
  return blockOf(name, expanded.recipe, enabled)
}

/** "Convert to a free automation": the stored recipe without its link, as a block. */
export function convertInstance(
  recipe: AutomationRecipe,
  name: string,
  enabled: boolean,
): InstanceBlock {
  return blockOf(name, detachAutomationInstance(recipe), enabled)
}
