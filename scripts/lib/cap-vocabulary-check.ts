/**
 * The judge behind `scripts/check-cap-vocabulary.ts` (D920): is the cap
 * vocabulary COMPLETE and TRUE against the capability definitions?
 *
 * The TypeScript types already refuse a method, status field or event name
 * the cap does not declare, and a missing cap. This judges what a type
 * cannot see:
 *
 *  - every cap has an entry, of the cap's own scope;
 *  - every OPERATE method of a device cap — not a read (`access: 'view'`),
 *    not an admin configuration method — is offered as an action or excused
 *    with a `notOperatorFacing` reason;
 *  - every declared cap event is phrased or excused;
 *  - every `{placeholder}` of a phrase names an arg it can be filled from;
 *  - every label carries `en` and `it`;
 *  - every offered value, fixed arg and state field agrees with the Zod
 *    schema it claims to describe (an enum value the method refuses, a number
 *    outside its bounds, a "boolean" field that is a string);
 *  - every icon is in the catalog, every action id is unique, every override
 *    rewords something that exists.
 *
 * Pure: it is handed the definitions, the vocabulary, the access map and the
 * icon set, so the spec can feed it small fakes.
 */
import { z } from 'zod'
import type {
  CapabilityDefinition,
  CapabilityMethodAccess,
} from '../../packages/types/src/capabilities/capability-definition.ts'
import { resolveMethodAuth } from '../../packages/types/src/capabilities/cap-router-predicates.ts'
import type {
  L10n,
  LooseCapVocabularyEntry,
  LooseDynamicOffer,
  LooseVocabAction,
  LooseVocabStateTrigger,
  LooseVocabWording,
} from '../../packages/types/src/device/cap-vocabulary/types.ts'

/** What the judge is handed. */
export interface CapVocabularyCheckInput {
  readonly defs: readonly CapabilityDefinition[]
  readonly vocabulary: Readonly<Record<string, LooseCapVocabularyEntry>>
  /** `access` of `<cap>.<method>`, or undefined when the map does not know it. */
  readonly accessOf: (cap: string, method: string) => CapabilityMethodAccess | undefined
  readonly iconKeys: ReadonlySet<string>
  /** Every value of the `EventCategory` enum. */
  readonly eventCategories: ReadonlySet<string>
}

/** What the judge found, plus the numbers it counted. */
export interface CapVocabularyCheckResult {
  readonly problems: readonly string[]
  readonly stats: {
    readonly caps: number
    readonly deviceCaps: number
    readonly systemCaps: number
    readonly operateMethods: number
    readonly actions: number
    readonly excusedMethods: number
    readonly stateTriggers: number
    readonly eventTriggers: number
    readonly excusedEvents: number
  }
}

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g

function placeholders(text: string): readonly string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? '')
}

/** Strip optional / nullable / default / readonly wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let cur: z.ZodType = schema
  for (let i = 0; i < 8; i++) {
    if (
      cur instanceof z.ZodOptional ||
      cur instanceof z.ZodNullable ||
      cur instanceof z.ZodDefault ||
      cur instanceof z.ZodReadonly
    ) {
      cur = cur.unwrap()
      continue
    }
    break
  }
  return cur
}

function objectShape(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | null {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodObject) return inner.shape
  return null
}

/** The values a schema accepts when it is a closed set; null otherwise. */
function closedValues(schema: z.ZodType): readonly (string | number)[] | null {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodEnum) return inner.options
  if (inner instanceof z.ZodLiteral) {
    return [...inner.values].filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    )
  }
  if (inner instanceof z.ZodUnion) {
    const out: (string | number)[] = []
    for (const option of inner.options) {
      if (!(option instanceof z.ZodType)) return null
      const vals = closedValues(option)
      if (vals === null) return null
      out.push(...vals)
    }
    return out
  }
  return null
}

type ScalarKind = 'boolean' | 'number' | 'string' | 'enum' | 'other'

function scalarKind(schema: z.ZodType): ScalarKind {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodBoolean) return 'boolean'
  if (inner instanceof z.ZodNumber) return 'number'
  if (inner instanceof z.ZodString) return 'string'
  if (closedValues(inner) !== null) return 'enum'
  if (inner instanceof z.ZodUnion) {
    const kinds = inner.options.map((o) => (o instanceof z.ZodType ? scalarKind(o) : 'other'))
    if (kinds.every((k) => k === 'string' || k === 'number')) return 'string'
  }
  return 'other'
}

function numberBounds(schema: z.ZodType): { min: number; max: number } | null {
  const inner = unwrap(schema)
  if (!(inner instanceof z.ZodNumber)) return null
  return { min: inner.minValue ?? -Infinity, max: inner.maxValue ?? Infinity }
}

function statusShape(def: CapabilityDefinition): Readonly<Record<string, z.ZodType>> | null {
  if (def.status !== undefined) {
    const shape = objectShape(def.status.schema)
    if (shape !== null) return shape
  }
  if (def.runtimeState !== undefined) return def.runtimeState.shape
  return null
}

/** Every `{ en, it }` in a value, with its path. */
function collectL10n(value: unknown, path: string, out: { path: string; value: object }[]): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectL10n(item, `${path}[${i}]`, out))
    return
  }
  if ('en' in value || 'it' in value) {
    out.push({ path, value })
    return
  }
  for (const [key, child] of Object.entries(value)) collectL10n(child, `${path}.${key}`, out)
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function checkL10nComplete(
  capName: string,
  entry: LooseCapVocabularyEntry,
  problems: string[],
): void {
  const found: { path: string; value: object }[] = []
  collectL10n(entry, capName, found)
  for (const { path, value } of found) {
    const en = 'en' in value ? value.en : undefined
    const it = 'it' in value ? value.it : undefined
    if (!nonEmpty(en)) problems.push(`${path}: label lacks 'en'`)
    if (!nonEmpty(it)) problems.push(`${path}: label lacks 'it'`)
  }
}

function checkPhrase(
  where: string,
  phrase: L10n | undefined,
  allowed: ReadonlySet<string>,
  problems: string[],
): void {
  if (phrase === undefined) return
  for (const lang of ['en', 'it'] as const) {
    for (const ph of placeholders(phrase[lang])) {
      if (!allowed.has(ph)) {
        problems.push(`${where} (${lang}): placeholder {${ph}} has no arg to fill it`)
      }
    }
  }
}

function checkDynamicOffer(
  where: string,
  def: CapabilityDefinition,
  offer: LooseDynamicOffer,
  accessOf: CapVocabularyCheckInput['accessOf'],
  problems: string[],
): void {
  if (offer.from === 'status') {
    const shape = statusShape(def)
    if (shape === null || !(offer.field in shape)) {
      problems.push(
        `${where}: dynamic offer reads status field '${offer.field}' that ${def.name} does not declare`,
      )
    }
    return
  }
  if (!(offer.method in def.methods)) {
    problems.push(
      `${where}: dynamic offer reads method '${offer.method}' that ${def.name} does not declare`,
    )
    return
  }
  if (accessOf(def.name, offer.method) !== 'view') {
    problems.push(
      `${where}: dynamic offer reads '${offer.method}', which is not a read (access 'view')`,
    )
  }
}

function checkAction(
  def: CapabilityDefinition,
  action: LooseVocabAction,
  input: CapVocabularyCheckInput,
  problems: string[],
): void {
  const where = `${def.name} action '${action.id}'`
  const method = def.methods[action.method]
  if (method === undefined) {
    problems.push(`${where}: method '${action.method}' does not exist on ${def.name}`)
    return
  }
  if (!input.iconKeys.has(action.icon))
    problems.push(`${where}: icon '${action.icon}' is not in the catalog`)
  const shape = objectShape(method.input) ?? {}
  const fixed = action.args ?? {}
  for (const [key, value] of Object.entries(fixed)) {
    const field = shape[key]
    if (field === undefined) {
      problems.push(`${where}: fixed arg '${key}' is not an input of ${def.name}.${action.method}`)
      continue
    }
    if (!field.safeParse(value).success) {
      problems.push(
        `${where}: fixed arg '${key}' = ${JSON.stringify(value)} is refused by the method's input schema`,
      )
    }
  }
  const open = action.openArgs ?? []
  for (const arg of open) {
    const field = shape[arg.key]
    if (field === undefined) {
      problems.push(
        `${where}: open arg '${arg.key}' is not an input of ${def.name}.${action.method}`,
      )
      continue
    }
    const offer = arg.offer
    if (offer.kind === 'enum') {
      const accepted = closedValues(field)
      for (const choice of offer.values) {
        if (
          accepted !== null
            ? !accepted.includes(choice.value)
            : !field.safeParse(choice.value).success
        ) {
          problems.push(
            `${where}: offered value ${JSON.stringify(choice.value)} for '${arg.key}' is refused by the input schema`,
          )
        }
      }
    } else if (offer.kind === 'number') {
      const bounds = numberBounds(field)
      if (bounds === null) {
        problems.push(`${where}: '${arg.key}' is offered as a number but the input is not one`)
      } else {
        if (offer.min !== undefined && offer.min < bounds.min) {
          problems.push(
            `${where}: '${arg.key}' offers min ${offer.min} below the schema's ${bounds.min}`,
          )
        }
        if (offer.max !== undefined && offer.max > bounds.max) {
          problems.push(
            `${where}: '${arg.key}' offers max ${offer.max} above the schema's ${bounds.max}`,
          )
        }
      }
    } else if (offer.kind === 'boolean') {
      if (scalarKind(field) !== 'boolean') {
        problems.push(`${where}: '${arg.key}' is offered as a boolean but the input is not one`)
      }
    } else if (offer.kind === 'dynamic') {
      checkDynamicOffer(where, def, offer, input.accessOf, problems)
      const kind = scalarKind(field)
      const declared = offer.valueKind ?? 'string'
      if ((kind === 'number') !== (declared === 'number')) {
        problems.push(
          `${where}: '${arg.key}' is offered as ${declared} values but the input takes ${kind}`,
        )
      }
    }
  }
  const allowed = new Set<string>(['device', ...Object.keys(fixed), ...open.map((a) => a.key)])
  checkPhrase(`${where} phrase`, action.phrase, allowed, problems)
}

function checkStateTrigger(
  def: CapabilityDefinition,
  trigger: LooseVocabStateTrigger,
  input: CapVocabularyCheckInput,
  problems: string[],
): void {
  const where = `${def.name} state '${trigger.field}'`
  if (!input.iconKeys.has(trigger.icon))
    problems.push(`${where}: icon '${trigger.icon}' is not in the catalog`)
  const shape = statusShape(def)
  const field = shape?.[trigger.field]
  if (field === undefined) {
    problems.push(`${where}: ${def.name} declares no status field '${trigger.field}'`)
    return
  }
  const kind = scalarKind(field)
  const device = new Set(['device'])
  if (trigger.kind === 'boolean') {
    if (kind !== 'boolean') problems.push(`${where}: phrased as boolean but the field is ${kind}`)
    checkPhrase(`${where} whenTrue`, trigger.whenTrue, device, problems)
    checkPhrase(`${where} whenFalse`, trigger.whenFalse, device, problems)
  } else if (trigger.kind === 'numeric') {
    if (kind !== 'number') problems.push(`${where}: phrased as numeric but the field is ${kind}`)
    if (trigger.unitField !== undefined && !(trigger.unitField in (shape ?? {}))) {
      problems.push(`${where}: unitField '${trigger.unitField}' is not a status field`)
    }
  } else if (trigger.kind === 'enum') {
    const accepted = closedValues(field)
    if (accepted === null) {
      problems.push(`${where}: phrased as enum but the field is ${kind}`)
    } else {
      for (const v of trigger.values) {
        if (!accepted.includes(v.value))
          problems.push(`${where}: value '${v.value}' is not one the field takes`)
      }
    }
    for (const v of trigger.values) {
      checkPhrase(`${where} value '${v.value}'`, v.phrase, new Set(['device', 'value']), problems)
    }
  } else {
    if (kind !== 'string' && kind !== 'enum')
      problems.push(`${where}: phrased as a value but the field is ${kind}`)
    if (trigger.offer !== undefined)
      checkDynamicOffer(where, def, trigger.offer, input.accessOf, problems)
    checkPhrase(`${where} phrase`, trigger.phrase, new Set(['device', 'value']), problems)
  }
}

function checkWording(
  def: CapabilityDefinition,
  key: string,
  wording: LooseVocabWording | undefined,
  entry: LooseCapVocabularyEntry,
  input: CapVocabularyCheckInput,
  problems: string[],
): void {
  if (wording === undefined) return
  const where = `${def.name} override '${key}'`
  const actions = new Map((entry.actions ?? []).map((a) => [a.id, a]))
  for (const [id, w] of Object.entries(wording.actions ?? {})) {
    const action = actions.get(id)
    if (action === undefined) {
      problems.push(`${where}: rewords action '${id}' that ${def.name} does not offer`)
      continue
    }
    if (w.icon !== undefined && !input.iconKeys.has(w.icon))
      problems.push(`${where}: icon '${w.icon}' is not in the catalog`)
    const allowed = new Set<string>([
      'device',
      ...Object.keys(action.args ?? {}),
      ...(action.openArgs ?? []).map((a) => a.key),
    ])
    checkPhrase(`${where} action '${id}'`, w.phrase, allowed, problems)
  }
  const fields = new Set((entry.state ?? []).map((s) => s.field))
  for (const [field, w] of Object.entries(wording.state ?? {})) {
    if (!fields.has(field)) {
      problems.push(`${where}: rewords state '${field}' that ${def.name} does not phrase`)
      continue
    }
    if (w === undefined) continue
    if (w.icon !== undefined && !input.iconKeys.has(w.icon))
      problems.push(`${where}: icon '${w.icon}' is not in the catalog`)
    checkPhrase(`${where} state '${field}' whenTrue`, w.whenTrue, new Set(['device']), problems)
    checkPhrase(`${where} state '${field}' whenFalse`, w.whenFalse, new Set(['device']), problems)
  }
}

/** Judge the vocabulary against the definitions. */
export function checkCapVocabulary(input: CapVocabularyCheckInput): CapVocabularyCheckResult {
  const problems: string[] = []
  const stats = {
    caps: 0,
    deviceCaps: 0,
    systemCaps: 0,
    operateMethods: 0,
    actions: 0,
    excusedMethods: 0,
    stateTriggers: 0,
    eventTriggers: 0,
    excusedEvents: 0,
  }
  const defsByName = new Map(input.defs.map((d) => [d.name, d]))
  for (const name of Object.keys(input.vocabulary)) {
    if (!defsByName.has(name))
      problems.push(`${name}: vocabulary entry for a cap that does not exist`)
  }
  const actionIds = new Map<string, string>()
  for (const def of input.defs) {
    const entry = input.vocabulary[def.name]
    if (entry === undefined) {
      problems.push(`${def.name}: cap has no vocabulary entry`)
      continue
    }
    stats.caps++
    if (entry.scope !== def.scope) {
      problems.push(`${def.name}: entry scope '${entry.scope}' but the cap is '${def.scope}'`)
      continue
    }
    checkL10nComplete(def.name, entry, problems)
    if (entry.scope === 'system') {
      stats.systemCaps++
      if (!nonEmpty(entry.notOperatorFacing)) {
        problems.push(`${def.name}: a system cap entry must say why it is not operator-facing`)
      }
      continue
    }
    stats.deviceCaps++
    if (entry.noun === undefined) problems.push(`${def.name}: device cap entry has no noun`)
    const actions = entry.actions ?? []
    const excuses = typeof entry.notOperatorFacing === 'object' ? entry.notOperatorFacing : {}
    for (const action of actions) {
      stats.actions++
      const prior = actionIds.get(action.id)
      if (prior !== undefined)
        problems.push(`${def.name} action '${action.id}': id already used by ${prior}`)
      actionIds.set(action.id, def.name)
      checkAction(def, action, input, problems)
    }
    for (const [method, reason] of Object.entries(excuses)) {
      if (!(method in def.methods))
        problems.push(`${def.name}: excuses method '${method}' that does not exist`)
      if (!nonEmpty(reason))
        problems.push(`${def.name}.${method}: notOperatorFacing needs a reason`)
    }
    const offered = new Set(actions.map((a) => a.method))
    for (const [methodName, method] of Object.entries(def.methods)) {
      const access = input.accessOf(def.name, methodName)
      if (access === 'view') continue
      if (resolveMethodAuth(def, method) === 'admin') continue
      stats.operateMethods++
      if (offered.has(methodName)) continue
      if (nonEmpty(excuses[methodName])) {
        stats.excusedMethods++
        continue
      }
      problems.push(
        `${def.name}.${methodName}: an operate method with no action and no notOperatorFacing reason`,
      )
    }
    for (const trigger of entry.state ?? []) {
      stats.stateTriggers++
      checkStateTrigger(def, trigger, input, problems)
    }
    const declaredEvents = Object.keys(def.events ?? {})
    const phrasedEvents = entry.events ?? {}
    for (const eventName of declaredEvents) {
      const ev = phrasedEvents[eventName]
      if (ev === undefined) {
        problems.push(
          `${def.name}: emitted event '${eventName}' has no phrase and no notOperatorFacing reason`,
        )
        continue
      }
      if ('notOperatorFacing' in ev) {
        stats.excusedEvents++
        if (!nonEmpty(ev.notOperatorFacing))
          problems.push(`${def.name} event '${eventName}': excuse needs a reason`)
        continue
      }
      stats.eventTriggers++
    }
    for (const eventName of Object.keys(phrasedEvents)) {
      if (!declaredEvents.includes(eventName)) {
        problems.push(`${def.name}: phrases event '${eventName}' that the cap does not declare`)
      }
    }
    const triggers = [
      ...Object.entries(phrasedEvents).flatMap(([k, ev]) =>
        'notOperatorFacing' in ev ? [] : [{ where: `${def.name} event '${k}'`, ev }],
      ),
      ...(entry.extraEvents ?? []).map((ev) => ({
        where: `${def.name} event '${ev.category}'`,
        ev,
      })),
    ]
    stats.eventTriggers += (entry.extraEvents ?? []).length
    for (const { where, ev } of triggers) {
      if (!input.eventCategories.has(ev.category))
        problems.push(`${where}: '${ev.category}' is not an EventCategory`)
      if (!input.iconKeys.has(ev.icon))
        problems.push(`${where}: icon '${ev.icon}' is not in the catalog`)
      checkPhrase(`${where} phrase`, ev.phrase, new Set(['device']), problems)
    }
    for (const [key, wording] of Object.entries(entry.overrides?.byType ?? {})) {
      checkWording(def, `type:${key}`, wording, entry, input, problems)
    }
    for (const [key, wording] of Object.entries(entry.overrides?.byRole ?? {})) {
      checkWording(def, `role:${key}`, wording, entry, input, problems)
    }
  }
  return { problems, stats }
}
