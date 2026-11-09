/**
 * Rule actions and shared sequences become Actions (D987, planning#473).
 *
 * Before: a notification rule carried hook bindings (`onTrigger`, `onTriggerOff`,
 * `onActivation`, `onDeactivation`) that were either a reference to a shared
 * sequence of the centre's own (`{ kind: 'sequence', sequenceId }`) or one inline
 * step (`{ kind: 'do', action }`), and its buttons named a `sequenceId`. The
 * sequences lived in the centre's `sequences` record kind.
 *
 * After: there is one place to author work — the Actions surface. A hook slot is
 * a list of Action ids and a button names an `actionId`.
 *
 *  - every sequence row becomes an Action with the sequence's name, steps and
 *    throttle (`minDelaySec`);
 *  - the inline steps of one hook become one Action named after the rule;
 *  - rules and buttons are rebound to the new ids.
 *
 * Idempotent in two ways. A rule already in the new shape is not touched. An
 * Action is found before it is made — same name, same steps, same throttle — so
 * a pass that died between making an Action and rewriting the rule that names it
 * reuses the Action on the rerun instead of leaving a twin.
 *
 * Nothing is deleted on a hunch (D49). The sequence rows go only after a second,
 * fresh read shows (a) no rule row still carries the old shape and (b) every
 * Action the rows were turned into is listed by the Actions surface. A sequence
 * whose steps the Actions step schema refuses is kept, named in the summary, and
 * the bindings that named it are dropped from the rule rather than rewritten to
 * an Action that does not exist.
 *
 * A `procedure`: the rows are records, written through the records engine, and
 * the Actions are made through the Actions cap — neither belongs in a plan.
 */
import {
  type ActionInput,
  ActionStepSchema,
  type ActionStep,
  type MigrationProcedureResult,
  NcRuleActionsSchema,
  type RecordKindHandle,
} from '@camstack/types'
import type { RuleBody, SequenceBody } from '../notification-center/record-kinds.js'
import { allRows } from './device-template-var.js'

/** The slice of an Action the migration compares and stores. */
export interface MigratedAction {
  readonly id: string
  readonly name: string
  readonly steps: readonly ActionStep[]
  readonly minDelaySec?: number | undefined
}

/** The Actions surface as the migration uses it. */
export interface NcMigrationActionsPort {
  list(): Promise<readonly MigratedAction[]>
  /** Make an internal Action; answers its id. */
  create(input: ActionInput): Promise<string>
}

export interface NcRuleActionsMigrationPorts {
  readonly rules: RecordKindHandle<RuleBody>
  readonly legacySequences: RecordKindHandle<SequenceBody>
  readonly actions: NcMigrationActionsPort
}

const NAME_MAX = 120

type HookKey = 'onActivation' | 'onDeactivation' | 'onTrigger' | 'onTriggerOff'

const HOOKS: readonly { readonly key: HookKey; readonly suffix: string }[] = [
  { key: 'onTrigger', suffix: '' },
  { key: 'onTriggerOff', suffix: ' (cleared)' },
  { key: 'onActivation', suffix: ' (rule on)' },
  { key: 'onDeactivation', suffix: ' (rule off)' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(name: string): string {
  return name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`
}

/** Same name, same throttle, same steps — what "the Action this migration would make" means. */
function sameAction(
  existing: MigratedAction,
  name: string,
  steps: readonly ActionStep[],
  minDelaySec: number | undefined,
): boolean {
  return (
    existing.name === name &&
    (existing.minDelaySec ?? 0) === (minDelaySec ?? 0) &&
    JSON.stringify(existing.steps) === JSON.stringify(steps)
  )
}

/** Finds or makes Actions, remembering what it made so one pass never makes a twin. */
class ActionBook {
  private readonly known: MigratedAction[]
  readonly madeIds = new Set<string>()
  made = 0

  constructor(
    private readonly port: NcMigrationActionsPort,
    initial: readonly MigratedAction[],
  ) {
    this.known = [...initial]
  }

  async ensure(
    rawName: string,
    steps: readonly ActionStep[],
    minDelaySec: number | undefined,
  ): Promise<string> {
    const name = clip(rawName)
    const found = this.known.find((a) => sameAction(a, name, steps, minDelaySec))
    if (found !== undefined) return found.id
    const id = await this.port.create({
      name,
      steps: [...steps],
      ...(minDelaySec !== undefined && minDelaySec > 0 ? { minDelaySec } : {}),
    })
    this.known.push({ id, name, steps, minDelaySec })
    this.madeIds.add(id)
    this.made += 1
    return id
  }
}

/** The steps of a legacy sequence row, or the first reason they do not parse. */
function parseSteps(
  body: SequenceBody,
): { readonly ok: true; readonly steps: readonly ActionStep[] } | { readonly ok: false } {
  const steps: ActionStep[] = []
  for (const raw of body.actions) {
    const parsed = ActionStepSchema.safeParse(raw)
    if (!parsed.success) return { ok: false }
    steps.push(parsed.data)
  }
  return steps.length === 0 ? { ok: false } : { ok: true, steps }
}

interface Counters {
  rules: number
  buttons: number
  inlineActions: number
  danglingBindings: number
  danglingButtons: number
}

/** A rule's `actions` block in the old shape, rebound; `null` when it is already new or absent. */
async function reboundActions(
  rule: RuleBody,
  bySequence: ReadonlyMap<string, string>,
  book: ActionBook,
  counters: Counters,
): Promise<Record<string, unknown> | null> {
  const legacy: unknown = Reflect.get(rule, 'actions')
  if (legacy === undefined) return null
  if (NcRuleActionsSchema.safeParse(legacy).success) return null
  if (!isRecord(legacy)) return {}

  const next: Record<string, unknown> = {}
  for (const { key, suffix } of HOOKS) {
    const bindings: unknown = legacy[key]
    if (!Array.isArray(bindings)) continue
    const ids: string[] = []
    let inline: ActionStep[] = []
    let groups = 0
    const flush = async (): Promise<void> => {
      if (inline.length === 0) return
      groups += 1
      const label = `${rule.name}${suffix}${groups > 1 ? ` #${groups}` : ''}`
      ids.push(await book.ensure(label, inline, undefined))
      counters.inlineActions += 1
      inline = []
    }
    for (const binding of bindings) {
      if (!isRecord(binding)) continue
      if (binding['kind'] === 'sequence' && typeof binding['sequenceId'] === 'string') {
        await flush()
        const actionId = bySequence.get(binding['sequenceId'])
        if (actionId === undefined) counters.danglingBindings += 1
        else if (!ids.includes(actionId)) ids.push(actionId)
      } else if (binding['kind'] === 'do') {
        const step = ActionStepSchema.safeParse(binding['action'])
        if (step.success) inline.push(step.data)
        else counters.danglingBindings += 1
      }
    }
    await flush()
    if (ids.length > 0) next[key] = ids.slice(0, 4)
  }

  const buttons: unknown = legacy['buttons']
  if (Array.isArray(buttons)) {
    const kept: Record<string, unknown>[] = []
    for (const button of buttons) {
      if (!isRecord(button)) continue
      const { sequenceId, ...rest } = button
      const actionId = typeof sequenceId === 'string' ? bySequence.get(sequenceId) : undefined
      if (actionId === undefined) {
        counters.danglingButtons += 1
        continue
      }
      kept.push({ ...rest, actionId })
      counters.buttons += 1
    }
    if (kept.length > 0) next['buttons'] = kept
  }
  return next
}

/** The rule with `actions` rebound (or removed when nothing is left of it). */
function ruleWith(rule: RuleBody, actions: Record<string, unknown>): RuleBody {
  const { actions: _old, ...rest } = rule
  const parsed = NcRuleActionsSchema.safeParse(actions)
  return parsed.success && Object.keys(parsed.data).length > 0
    ? { ...rest, actions: parsed.data }
    : rest
}

/** True when any rule row still carries an `actions` block the new schema refuses. */
async function legacyRuleRows(kind: RecordKindHandle<RuleBody>): Promise<number> {
  let left = 0
  for (const row of await allRows(kind)) {
    const actions: unknown = Reflect.get(row.data, 'actions')
    if (actions !== undefined && !NcRuleActionsSchema.safeParse(actions).success) left += 1
  }
  return left
}

export async function migrateRuleActionsToActions(
  ports: NcRuleActionsMigrationPorts,
): Promise<MigrationProcedureResult> {
  const sequenceRows = await allRows(ports.legacySequences)
  const ruleRows = await allRows(ports.rules)
  const hasLegacyRule = ruleRows.some((row) => {
    const actions: unknown = Reflect.get(row.data, 'actions')
    return actions !== undefined && !NcRuleActionsSchema.safeParse(actions).success
  })
  if (sequenceRows.length === 0 && !hasLegacyRule) {
    return { outcome: 'already-done', summary: { sequences: 0, rules: 0 } }
  }

  const book = new ActionBook(ports.actions, await ports.actions.list())
  const counters: Counters = {
    rules: 0,
    buttons: 0,
    inlineActions: 0,
    danglingBindings: 0,
    danglingButtons: 0,
  }

  // 1. A sequence is an Action. One the Actions step schema refuses stays a row.
  const bySequence = new Map<string, string>()
  const unparsable: string[] = []
  for (const row of sequenceRows) {
    const steps = parseSteps(row.data)
    if (!steps.ok) {
      unparsable.push(row.id)
      continue
    }
    bySequence.set(row.id, await book.ensure(row.data.name, steps.steps, row.data.minDelaySec))
  }

  // 2. Rules and buttons are rebound. `ifRev`: a rule the operator saved since it was read is
  //    not overwritten; the migration fails and the rerun reads the new row.
  for (const row of ruleRows) {
    const actions = await reboundActions(row.data, bySequence, book, counters)
    if (actions === null) continue
    await ports.rules.put({ id: row.id, data: ruleWith(row.data, actions) }, { ifRev: row.rev })
    counters.rules += 1
  }

  // 3. The sequence rows go only after a fresh read confirms nothing needs them (D49).
  const stillLegacy = await legacyRuleRows(ports.rules)
  const listed = new Set((await ports.actions.list()).map((a) => a.id))
  const convertible = [...bySequence.entries()]
  const allListed = convertible.every(([, actionId]) => listed.has(actionId))
  let deleted = 0
  if (stillLegacy === 0 && allListed) {
    for (const [sequenceId] of convertible) {
      await ports.legacySequences.delete(sequenceId)
      deleted += 1
    }
  }

  const changed = book.made + counters.rules + deleted
  return {
    outcome: changed === 0 ? 'already-done' : 'done',
    summary: {
      sequencesToActions: convertible.length,
      actionsMade: book.made,
      inlineActions: counters.inlineActions,
      rulesRebound: counters.rules,
      buttonsRebound: counters.buttons,
      danglingBindings: counters.danglingBindings,
      danglingButtons: counters.danglingButtons,
      sequenceRowsDeleted: deleted,
      sequenceRowsKept: sequenceRows.length - deleted,
      unparsableSequences: unparsable.length,
    },
  }
}
