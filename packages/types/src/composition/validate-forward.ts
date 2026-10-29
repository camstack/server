/**
 * Save-time validation of `forward` commands (D659, amended by D967).
 *
 * A BUILT capability serves a method only through a command, so every method
 * the cap serves needs one. A forward is checked against the two input schemas
 * it joins: the BUILT method's (what the caller sends) and the SOURCE method's
 * (what is called). An input field in neither place is refused BY NAME, and so
 * is a required source input nothing provides. `deviceId` is the source's own
 * and is never an argument.
 *
 * Static: it needs only the capability definitions. That the source DEVICE
 * exists and binds the cap is `forwardSourceProblems`, with the sources read.
 */
import { z } from 'zod'
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import { unwrapSchema } from '../device/schema-fields.js'
import {
  type Composition,
  type CompositionFieldsFeature,
  type CompositionForwardArg,
  type CompositionForwardCommand,
  type CompositionSourceRef,
  compositionFeatureEnabled,
  compositionSourceKey,
  isForwardInputRef,
} from './composition.js'
import type { CompositionProblem } from './composition-report.js'
import { problem } from './plan-result.js'
import type { CapabilityLookup, CompositionSourceDescription } from './validate-composition.js'

/** A forward and where it sits in the composition, for a refusal that names the place. */
export interface PlacedForward {
  /** `features[0].commands.setPump` or `features[0].items.filter.reset`. */
  readonly at: string
  /** The built method it serves. */
  readonly method: string
  /** Set for an item's `reset`: the item key selects the command and is not an argument. */
  readonly itemKey?: string
  readonly command: CompositionForwardCommand
}

export const DEVICE_ID_FIELD = 'deviceId'

/** Every forward of a feature: the method commands, then each item's `reset`. */
export function featureForwards(
  feature: CompositionFieldsFeature,
  featureIndex: number,
): readonly PlacedForward[] {
  const at = `features[${featureIndex}]`
  const commands = Object.entries(feature.commands ?? {}).flatMap(
    ([method, target]): readonly PlacedForward[] =>
      target.kind === 'forward'
        ? [{ at: `${at}.commands.${method}`, method, command: target }]
        : [],
  )
  const resets = Object.entries(feature.items ?? {}).flatMap(
    ([key, item]): readonly PlacedForward[] =>
      item.reset === undefined
        ? []
        : [
            {
              at: `${at}.items.${key}.reset`,
              method: 'reset',
              itemKey: key,
              command: item.reset,
            },
          ],
  )
  return [...commands, ...resets]
}

/** Every source a forward of an enabled feature calls, once. */
export function forwardSourceRefs(composition: Composition): readonly CompositionSourceRef[] {
  const refs = composition.features.flatMap((feature, index) =>
    feature.kind === 'fields' && compositionFeatureEnabled(feature)
      ? featureForwards(feature, index).map((forward) => forward.command.source)
      : [],
  )
  return [...new Map(refs.map((ref) => [compositionSourceKey(ref), ref])).values()]
}

/** The methods a BUILT cap must give a command: served, and not answered by the composer itself. */
export function commandedMethods(def: CapabilityDefinition): readonly string[] {
  return Object.entries(def.methods)
    .filter(([name, m]) => m.systemOnly !== true && def.composedMethods?.[name] === undefined)
    .map(([name]) => name)
}

interface InputFields {
  readonly all: ReadonlySet<string>
  readonly required: ReadonlySet<string>
}

const NO_INPUT: InputFields = { all: new Set(), required: new Set() }

/** The top-level input fields of a method, `deviceId` removed; null when the input is not an object. */
function inputFields(def: CapabilityDefinition, method: string): InputFields | null {
  const input = def.methods[method]?.input
  if (input === undefined) return null
  const root = unwrapSchema(input)
  if (!(root instanceof z.ZodObject)) return null
  const entries = Object.entries(root.shape).filter(([name]) => name !== DEVICE_ID_FIELD)
  return {
    all: new Set(entries.map(([name]) => name)),
    required: new Set(
      entries.flatMap(([name, field]) =>
        field instanceof z.ZodType && !field.safeParse(undefined).success ? [name] : [],
      ),
    ),
  }
}

function inputRefs(arg: CompositionForwardArg): readonly string[] {
  if (typeof arg !== 'object') return []
  if (isForwardInputRef(arg)) return [arg.$input]
  return Object.values(arg).flatMap(inputRefs)
}

function names(list: Iterable<string>): string {
  return [...list].map((name) => `\`${name}\``).join(', ')
}

type SourceMethod =
  | { readonly def: CapabilityDefinition; readonly problems: readonly [] }
  | { readonly def: null; readonly problems: readonly CompositionProblem[] }

function sourceMethodOf(forward: PlacedForward, lookupCap: CapabilityLookup): SourceMethod {
  const { command, at } = forward
  const def = lookupCap(command.cap)
  if (def === null) {
    return {
      def: null,
      problems: [
        problem('command-source-unknown', `${at}.cap`, `no capability is named \`${command.cap}\``),
      ],
    }
  }
  const served = def.methods[command.method]
  if (served === undefined || served.systemOnly === true) {
    return {
      def: null,
      problems: [
        problem(
          'command-source-unknown',
          `${at}.method`,
          `\`${command.cap}\` has no method \`${command.method}\` to forward to`,
        ),
      ],
    }
  }
  if (served.kind !== 'mutation') {
    return {
      def: null,
      problems: [
        problem(
          'command-source-unknown',
          `${at}.method`,
          `\`${command.cap}.${command.method}\` is a query — a command calls a mutation of the source`,
        ),
      ],
    }
  }
  return { def, problems: [] }
}

function mappedInputProblems(
  forward: PlacedForward,
  built: InputFields | null,
  source: InputFields | null,
  args: Readonly<Record<string, CompositionForwardArg>>,
): readonly CompositionProblem[] {
  const { at, command } = forward
  const where = `${command.cap}.${command.method}`
  const problems: CompositionProblem[] = []
  if (DEVICE_ID_FIELD in args) {
    problems.push(
      problem(
        'command-input-unknown',
        `${at}.args.${DEVICE_ID_FIELD}`,
        `\`${DEVICE_ID_FIELD}\` is the source device's own — a forward never takes it as an argument`,
      ),
    )
  }
  if (source !== null) {
    for (const key of Object.keys(args).filter(
      (k) => k !== DEVICE_ID_FIELD && !source.all.has(k),
    )) {
      problems.push(
        problem(
          'command-input-unknown',
          `${at}.args.${key}`,
          `\`${where}\` has no input field \`${key}\` (it takes ${names(source.all)})`,
        ),
      )
    }
    const missing = [...source.required].filter((k) => !(k in args))
    if (missing.length > 0) {
      problems.push(
        problem(
          'command-input-missing',
          `${at}.args`,
          `\`${where}\` needs ${names(missing)}, which \`args\` does not provide`,
        ),
      )
    }
  }
  // An item's reset reads nothing: the item key selects the command.
  const readable = forward.itemKey === undefined ? built : NO_INPUT
  if (readable !== null) {
    for (const ref of Object.values(args).flatMap(inputRefs)) {
      if (readable.all.has(ref)) continue
      problems.push(
        problem(
          'command-input-unknown',
          `${at}.args`,
          readable === NO_INPUT
            ? `an item's \`reset\` takes no input — \`$input: ${ref}\` has nothing to read`
            : `\`$input: ${ref}\` is not a field of the \`${forward.method}\` input (it takes ${names(readable.all)})`,
        ),
      )
    }
  }
  return problems
}

function passthroughInputProblems(
  forward: PlacedForward,
  built: InputFields | null,
  source: InputFields | null,
): readonly CompositionProblem[] {
  const { at, command } = forward
  const where = `${command.cap}.${command.method}`
  const sent = forward.itemKey === undefined ? built : NO_INPUT
  if (sent === null || source === null) return []
  const problems: CompositionProblem[] = []
  for (const field of [...sent.all].filter((f) => !source.all.has(f))) {
    problems.push(
      problem(
        'command-input-unknown',
        `${at}.args`,
        `\`${forward.method}\` takes \`${field}\`, which \`${where}\` does not (it takes ${names(source.all)}) — add \`args\` to map it`,
      ),
    )
  }
  const missing = [...source.required].filter((k) => !sent.all.has(k))
  if (missing.length > 0) {
    problems.push(
      problem(
        'command-input-missing',
        `${at}.args`,
        `\`${where}\` needs ${names(missing)}, which \`${forward.method}\` does not take — add \`args\` to provide it`,
      ),
    )
  }
  return problems
}

/** One forward against the built cap's method and the source cap's method. */
export function forwardProblems(
  built: CapabilityDefinition,
  forward: PlacedForward,
  lookupCap: CapabilityLookup,
): readonly CompositionProblem[] {
  const source = sourceMethodOf(forward, lookupCap)
  if (source.def === null) return source.problems
  const builtFields = inputFields(built, forward.method)
  const sourceFields = inputFields(source.def, forward.command.method)
  const mapping = forward.command.args
  return mapping === undefined
    ? passthroughInputProblems(forward, builtFields, sourceFields)
    : mappedInputProblems(forward, builtFields, sourceFields, mapping)
}

/** A command must name a method the built cap serves and the composer does not answer itself. */
export function commandMethodProblems(
  built: CapabilityDefinition,
  feature: CompositionFieldsFeature,
  at: string,
): readonly CompositionProblem[] {
  const commanded = new Set(commandedMethods(built))
  return Object.keys(feature.commands ?? {}).flatMap((method): readonly CompositionProblem[] => {
    if (commanded.has(method)) return []
    const answered = built.composedMethods?.[method] !== undefined
    return [
      problem(
        'command-method-unknown',
        `${at}.commands.${method}`,
        answered
          ? `\`${built.name}.${method}\` is answered by the composer itself — an item's \`reset\` serves it`
          : `\`${built.name}\` has no method \`${method}\` to serve`,
      ),
    ]
  })
}

/**
 * The source DEVICES of the forwards, read: each must exist and bind the cap it
 * is called on. A forward onto an unread device is refused rather than stored
 * unchecked, like every other source (D391).
 */
export function forwardSourceProblems(
  composition: Composition,
  sources: ReadonlyMap<string, CompositionSourceDescription>,
): readonly CompositionProblem[] {
  return composition.features.flatMap((feature, index): readonly CompositionProblem[] => {
    if (feature.kind !== 'fields' || !compositionFeatureEnabled(feature)) return []
    return featureForwards(feature, index).flatMap((forward): readonly CompositionProblem[] => {
      const key = compositionSourceKey(forward.command.source)
      const desc = sources.get(key)
      const at = `${forward.at}.source`
      if (desc === undefined || desc.kind === 'unreadable') {
        const why = desc === undefined ? 'it was not read' : desc.error
        return [
          problem(
            'source-unreadable',
            at,
            `could not read source \`${key}\` (${why}) — the save is refused rather than stored unchecked`,
          ),
        ]
      }
      if (desc.kind === 'absent')
        return [problem('source-missing', at, `source \`${key}\` does not exist`)]
      if (!desc.caps.has(forward.command.cap)) {
        return [
          problem(
            'source-capability-missing',
            at,
            `source \`${key}\` (device ${desc.deviceId}) has no \`${forward.command.cap}\``,
          ),
        ]
      }
      return []
    })
  })
}
