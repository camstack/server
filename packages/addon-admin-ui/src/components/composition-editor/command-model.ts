/**
 * The commands of a BUILT capability, as the card editor reads and writes them
 * (D967). A built device serves a method only through a `forward`; this file
 * is the pure half of that editor: which methods need one, which source
 * methods a forward may call, what the args template looks like, and the
 * refusals the validator gives a row. It reads every list from the generated
 * capability definitions — there is no table of "forwardable" methods here.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  type CapabilityDefinition,
  type CapabilityLookup,
  commandedMethods,
  commandMethodProblems,
  type CompositionFieldsFeature,
  type CompositionForwardArg,
  CompositionForwardArgSchema,
  type CompositionForwardCommand,
  type CompositionProblem,
  type CompositionSourceRef,
  DEVICE_ID_FIELD,
  forwardProblems,
  isForwardInputRef,
  type PlacedForward,
  unwrapSchema,
} from '@camstack/types'
import { z } from 'zod'

export const capabilityLookup: CapabilityLookup = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)

/** The generated definition of a cap by name, or null. */
export function capabilityDefOf(name: string): CapabilityDefinition | null {
  return ALL_CAPABILITY_DEFINITIONS.find((def) => def.name === name) ?? null
}

export type CommandRowKind = 'method' | 'reset'

/** One thing a built feature must serve: a cap method, or an item's `reset`. */
export interface CommandRow {
  /** Stable within a feature: the method name, or `items.<key>.reset`. */
  readonly id: string
  readonly kind: CommandRowKind
  /** The BUILT method the forward serves (`reset` for an item's reset). */
  readonly method: string
  readonly itemKey: string | null
  /** The stored forward; null while the row has none. */
  readonly command: CompositionForwardCommand | null
  /** A stored command naming a method the cap does not serve: shown so it can be refused and removed. */
  readonly orphan: boolean
}

/** The rows of one feature, in the order the cap declares them; orphans last. */
export function commandRows(
  def: CapabilityDefinition,
  feature: CompositionFieldsFeature,
): readonly CommandRow[] {
  const stored = feature.commands ?? {}
  const served = commandedMethods(def)
  const forwardOf = (method: string): CompositionForwardCommand | null => {
    const target = stored[method]
    return target !== undefined && target.kind === 'forward' ? target : null
  }
  const methods: readonly CommandRow[] = served.map((method) => ({
    id: method,
    kind: 'method',
    method,
    itemKey: null,
    command: forwardOf(method),
    orphan: false,
  }))
  const resets: readonly CommandRow[] = Object.entries(feature.items ?? {}).map(([key, item]) => ({
    id: `items.${key}.reset`,
    kind: 'reset',
    method: 'reset',
    itemKey: key,
    command: item.reset ?? null,
    orphan: false,
  }))
  const orphans: readonly CommandRow[] = Object.keys(stored)
    .filter((method) => !served.includes(method))
    .map((method) => ({
      id: method,
      kind: 'method',
      method,
      itemKey: null,
      command: forwardOf(method),
      orphan: true,
    }))
  return [...methods, ...resets, ...orphans]
}

/** Whether a feature has anything to command: a method that needs one, or an item with a reset. */
export function hasCommandRows(
  def: CapabilityDefinition,
  feature: CompositionFieldsFeature,
): boolean {
  return commandRows(def, feature).length > 0
}

/** The feature with one row's command set, or removed when `command` is null. Everything else stays. */
export function withRowCommand(
  feature: CompositionFieldsFeature,
  row: CommandRow,
  command: CompositionForwardCommand | null,
): CompositionFieldsFeature {
  if (row.kind === 'reset' && row.itemKey !== null) {
    const item = feature.items?.[row.itemKey]
    if (item === undefined || feature.items === undefined) return feature
    const { reset: _reset, ...rest } = item
    const next = command === null ? rest : { ...rest, reset: command }
    return { ...feature, items: { ...feature.items, [row.itemKey]: next } }
  }
  const commands = feature.commands ?? {}
  if (command !== null) return { ...feature, commands: { ...commands, [row.method]: command } }
  const remaining = Object.fromEntries(
    Object.entries(commands).filter(([method]) => method !== row.method),
  )
  if (Object.keys(remaining).length > 0) return { ...feature, commands: remaining }
  const { commands: _commands, ...rest } = feature
  return rest
}

/** The forward as the validator places it, for a refusal that names the place. */
export function placedForward(
  row: CommandRow,
  featureIndex: number,
  command: CompositionForwardCommand,
): PlacedForward {
  const at =
    row.kind === 'reset'
      ? `features[${featureIndex}].items.${row.itemKey}.reset`
      : `features[${featureIndex}].commands.${row.method}`
  return {
    at,
    method: row.method,
    ...(row.itemKey === null ? {} : { itemKey: row.itemKey }),
    command,
  }
}

/**
 * What the validator says about a row, by code: the forward against the two
 * input schemas it joins, and a stored command the cap does not serve.
 * `has-commands` is the card's, not a row's (it lists every unserved method).
 */
export function rowProblems(
  def: CapabilityDefinition,
  feature: CompositionFieldsFeature,
  featureIndex: number,
  row: CommandRow,
  command: CompositionForwardCommand | null,
): readonly CompositionProblem[] {
  const method =
    row.orphan && row.kind === 'method'
      ? commandMethodProblems(def, feature, `features[${featureIndex}]`).filter(
          (p) => p.path === `features[${featureIndex}].commands.${row.method}`,
        )
      : []
  if (command === null) return method
  return [
    ...method,
    ...forwardProblems(def, placedForward(row, featureIndex, command), capabilityLookup),
  ]
}

/** The methods a feature still has no command for (the validator's `has-commands` list). */
export function unservedMethods(
  def: CapabilityDefinition,
  feature: CompositionFieldsFeature,
): readonly string[] {
  return commandRows(def, feature)
    .filter((row) => row.kind === 'method' && !row.orphan && row.command === null)
    .map((row) => row.method)
}

/** Mutations of a source cap a forward may call: served, not system-only. */
export function forwardableMethods(def: CapabilityDefinition): readonly string[] {
  return Object.entries(def.methods)
    .filter(([, method]) => method.kind === 'mutation' && method.systemOnly !== true)
    .map(([name]) => name)
}

/** Caps from `names` that carry at least one method a forward may call, in definition order. */
export function forwardableCaps(names: readonly string[]): readonly CapabilityDefinition[] {
  const wanted = new Set(names)
  return ALL_CAPABILITY_DEFINITIONS.filter(
    (def) => wanted.has(def.name) && forwardableMethods(def).length > 0,
  )
}

export type InputFieldType = 'boolean' | 'number' | 'string' | 'structured'

export interface InputField {
  readonly name: string
  readonly required: boolean
  readonly type: InputFieldType
}

function fieldTypeOf(field: z.ZodType): InputFieldType {
  const inner = unwrapSchema(field)
  if (inner instanceof z.ZodBoolean) return 'boolean'
  if (inner instanceof z.ZodNumber) return 'number'
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return 'string'
  return 'structured'
}

/** The top-level input fields of a method, `deviceId` removed (it is the source's own). */
export function inputFieldsOf(def: CapabilityDefinition, method: string): readonly InputField[] {
  const input = def.methods[method]?.input
  if (input === undefined) return []
  const root = unwrapSchema(input)
  if (!(root instanceof z.ZodObject)) return []
  return Object.entries(root.shape)
    .filter(([name]) => name !== DEVICE_ID_FIELD)
    .flatMap(([name, field]): readonly InputField[] =>
      field instanceof z.ZodType
        ? [
            {
              name,
              required: !field.safeParse(undefined).success,
              type: fieldTypeOf(field),
            },
          ]
        : [],
    )
}

/** What one source input field is given in a template. */
export type ArgChoice =
  | { readonly kind: 'input'; readonly field: string }
  | { readonly kind: 'constant'; readonly value: string | number | boolean }
  | { readonly kind: 'structured'; readonly value: CompositionForwardArg }

export function choiceOf(arg: CompositionForwardArg): ArgChoice {
  if (typeof arg === 'object') {
    return isForwardInputRef(arg)
      ? { kind: 'input', field: arg.$input }
      : { kind: 'structured', value: arg }
  }
  return { kind: 'constant', value: arg }
}

export function argOf(choice: ArgChoice): CompositionForwardArg {
  if (choice.kind === 'input') return { $input: choice.field }
  return choice.value
}

/** The template with one source field given, or left out when `arg` is undefined. */
export function withArg(
  args: Readonly<Record<string, CompositionForwardArg>>,
  name: string,
  arg: CompositionForwardArg | undefined,
): Record<string, CompositionForwardArg> {
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== name))
  return arg === undefined ? rest : { ...rest, [name]: arg }
}

/** A starting choice for a field the operator is about to map. */
export function defaultChoice(field: InputField, builtFields: readonly string[]): ArgChoice {
  if (builtFields.includes(field.name)) return { kind: 'input', field: field.name }
  if (field.type === 'boolean') return { kind: 'constant', value: true }
  if (field.type === 'number') return { kind: 'constant', value: 0 }
  if (field.type === 'string') return { kind: 'constant', value: '' }
  return { kind: 'structured', value: {} }
}

/** Parse the text of a structured argument; null when it is not a valid template value. */
export function parseStructuredArg(text: string): CompositionForwardArg | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const checked = CompositionForwardArgSchema.safeParse(parsed)
    return checked.success ? checked.data : null
  } catch {
    return null
  }
}

/** The operator's work on one row before it is applied: nothing here is stored until it is complete. */
export interface RowDraft {
  readonly source: CompositionSourceRef | null
  readonly cap: string
  readonly method: string
  /** Undefined = the built method's input passes through; a record = the template IS the source input. */
  readonly args: Readonly<Record<string, CompositionForwardArg>> | undefined
}

export const EMPTY_ROW_DRAFT: RowDraft = { source: null, cap: '', method: '', args: undefined }

export function rowDraftOf(command: CompositionForwardCommand | null): RowDraft {
  if (command === null) return EMPTY_ROW_DRAFT
  return {
    source: command.source,
    cap: command.cap,
    method: command.method,
    args: command.args,
  }
}

/** The forward a draft stands for; null until the source, cap and method are all chosen. */
export function commandOfDraft(draft: RowDraft): CompositionForwardCommand | null {
  if (draft.source === null || draft.cap === '' || draft.method === '') return null
  return {
    kind: 'forward',
    source: draft.source,
    cap: draft.cap,
    method: draft.method,
    ...(draft.args === undefined ? {} : { args: draft.args }),
  }
}
