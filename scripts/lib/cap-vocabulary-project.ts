/**
 * Projects the vocabulary a capability DECLARES (D1050) into the entry of the
 * cap vocabulary map (D920): actions off the methods they call, event wording
 * off the events, the rest off the cap's `vocabulary` block. Pure — the
 * generator (`scripts/generate-cap-vocabulary.ts`) and its spec share it.
 */
import type {
  CapabilityDefinition,
  CapabilityEventSchema,
  CapabilityMethodSchema,
} from '../../packages/types/src/capabilities/capability-definition.ts'
import type {
  LooseCapVocabularyEntry,
  LooseVocabAction,
  VocabEventTrigger,
} from '../../packages/types/src/device/cap-vocabulary/types.ts'

/** One projected entry, with the picker order a device entry carries. */
export interface ProjectedVocabularyEntry {
  readonly cap: string
  /** Device caps: the declared picker order. System caps: none (they sort last, by name). */
  readonly order: number | null
  readonly entry: LooseCapVocabularyEntry
}

/** Why a cap's declarations cannot be projected. */
export class CapVocabularyDeclarationError extends Error {}

function methodsOf(
  def: CapabilityDefinition,
): readonly (readonly [string, CapabilityMethodSchema])[] {
  return Object.entries(def.methods)
}

function eventsOf(
  def: CapabilityDefinition,
): readonly (readonly [string, CapabilityEventSchema])[] {
  return def.events === undefined ? [] : Object.entries(def.events)
}

function projectActions(def: CapabilityDefinition): readonly LooseVocabAction[] {
  return methodsOf(def).flatMap(([method, schema]) =>
    (schema.actions ?? []).map(
      (a): LooseVocabAction => ({
        id: a.id,
        method,
        label: a.label,
        phrase: a.phrase,
        icon: a.icon,
        ...(a.args !== undefined ? { args: a.args } : {}),
        ...(a.openArgs !== undefined ? { openArgs: a.openArgs } : {}),
        ...(a.effect !== undefined ? { effect: a.effect } : {}),
      }),
    ),
  )
}

function projectExcuses(def: CapabilityDefinition): Readonly<Record<string, string>> {
  return Object.fromEntries(
    methodsOf(def).flatMap(([method, schema]) =>
      schema.notOperatorFacing === undefined ? [] : [[method, schema.notOperatorFacing]],
    ),
  )
}

type EventEntry = VocabEventTrigger | { readonly notOperatorFacing: string }

function projectEvents(def: CapabilityDefinition): Readonly<Record<string, EventEntry>> {
  const out: Record<string, EventEntry> = {}
  for (const [name, ev] of eventsOf(def)) {
    if (ev.trigger !== undefined) out[name] = ev.trigger
    else if (ev.notOperatorFacing !== undefined)
      out[name] = { notOperatorFacing: ev.notOperatorFacing }
    else
      throw new CapVocabularyDeclarationError(
        `${def.name}: event '${name}' declares neither a trigger nor a notOperatorFacing reason`,
      )
  }
  return out
}

/** The vocabulary entry of one cap, from its declarations. */
export function projectCapVocabulary(def: CapabilityDefinition): ProjectedVocabularyEntry {
  const decl = def.vocabulary
  if (decl === undefined)
    throw new CapVocabularyDeclarationError(`${def.name}: no \`vocabulary\` block`)
  if (def.scope === 'system') {
    if (decl.notOperatorFacing === undefined)
      throw new CapVocabularyDeclarationError(
        `${def.name}: a system cap's vocabulary is only its notOperatorFacing reason`,
      )
    return {
      cap: def.name,
      order: null,
      entry: { scope: 'system', notOperatorFacing: decl.notOperatorFacing },
    }
  }
  if (decl.noun === undefined)
    throw new CapVocabularyDeclarationError(`${def.name}: a device cap's vocabulary needs a noun`)
  const actions = projectActions(def)
  const excuses = projectExcuses(def)
  const events = projectEvents(def)
  const entry: LooseCapVocabularyEntry = {
    scope: 'device',
    noun: decl.noun,
    ...(actions.length > 0 ? { actions } : {}),
    ...(Object.keys(excuses).length > 0 ? { notOperatorFacing: excuses } : {}),
    ...(decl.state !== undefined ? { state: decl.state } : {}),
    ...(Object.keys(events).length > 0 ? { events } : {}),
    ...(decl.extraEvents !== undefined ? { extraEvents: decl.extraEvents } : {}),
    ...(decl.overrides !== undefined ? { overrides: decl.overrides } : {}),
  }
  return { cap: def.name, order: decl.order, entry }
}

/**
 * Every cap's entry, in map order: device caps by their declared `order`
 * (the order a picker draws them in), then system caps by name. Two device
 * caps declaring one order is refused — the order would depend on the file
 * system.
 */
export function projectCapVocabularies(
  defs: readonly CapabilityDefinition[],
): readonly ProjectedVocabularyEntry[] {
  const projected = defs.map(projectCapVocabulary)
  const seen = new Map<number, string>()
  for (const p of projected) {
    if (p.order === null) continue
    const other = seen.get(p.order)
    if (other !== undefined)
      throw new CapVocabularyDeclarationError(
        `${p.cap} and ${other} both declare vocabulary order ${p.order}`,
      )
    seen.set(p.order, p.cap)
  }
  return projected.toSorted((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order
    if (a.order !== null) return -1
    if (b.order !== null) return 1
    return a.cap.localeCompare(b.cap)
  })
}
