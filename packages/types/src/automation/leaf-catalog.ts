/**
 * The one catalogue of `when`-tree row kinds: what each kind is (an event or a
 * state), where it files in a picker, where it may be used, what text names it
 * and what a blank row of it looks like.
 *
 * It is TOTAL over `AutomationLeaf['kind']` by its type: a new leaf kind
 * without an entry does not compile. The texts are i18n keys, never strings —
 * `<i18nKey>.label`, `.description` and `.example` live in the UI locales.
 *
 * Framework-free on purpose: the admin picker and the phone sheet read the same
 * model.
 */
import type { AutomationLeaf } from './when.js'

export type AutomationLeafKind = AutomationLeaf['kind']

/** Picker groups, in display order. */
export const AUTOMATION_LEAF_CATEGORIES = [
  'devices',
  'time',
  'cameras',
  'events',
  'logic',
  'system',
] as const
export type AutomationLeafCategory = (typeof AUTOMATION_LEAF_CATEGORIES)[number]

/** An event HAPPENS (an instant); a state HOLDS (a fact that is true or not). */
export type AutomationLeafRole = 'event' | 'state'

/**
 * Where a row is being added: the `when` tree of an automation (`trigger`), a
 * step's `if` (`guard`, states only — a step has no instant to wait for), or a
 * place with no restriction (`any`).
 */
export type AutomationLeafContext = 'trigger' | 'guard' | 'any'

export interface AutomationLeafCatalogEntry<K extends AutomationLeafKind = AutomationLeafKind> {
  readonly kind: K
  readonly category: AutomationLeafCategory
  readonly role: AutomationLeafRole
  readonly allowedIn: readonly AutomationLeafContext[]
  /** Base key: `.label`, `.description` and `.example` under it. */
  readonly i18nKey: `automation.leafCatalog.${K}`
  /** Extra search words, lower case, English: what an operator types. */
  readonly keywords: readonly string[]
  /** The next step after picking this kind is choosing a device value. */
  readonly needsDeviceValue: boolean
  /** A blank row. Optional keys are OMITTED, never `undefined`: the recipe is
   *  serialised into the generated file. A fresh object on every call. */
  readonly seed: () => Extract<AutomationLeaf, { kind: K }>
}

export type AutomationLeafCatalog = {
  readonly [K in AutomationLeafKind]: AutomationLeafCatalogEntry<K>
}

const EVENT_CONTEXTS: readonly AutomationLeafContext[] = ['trigger', 'any']
const STATE_CONTEXTS: readonly AutomationLeafContext[] = ['trigger', 'guard', 'any']

export const AUTOMATION_LEAF_CATALOG: AutomationLeafCatalog = {
  detection: {
    kind: 'detection',
    category: 'cameras',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.detection',
    keywords: ['camera', 'person', 'vehicle', 'animal', 'object', 'motion', 'detected'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'detection', subjects: [{ macro: 'person' }], deviceIds: [] }),
  },
  stationary: {
    kind: 'stationary',
    category: 'cameras',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.stationary',
    keywords: ['camera', 'parked', 'stops', 'leaves', 'left', 'appeared', 'object'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'stationary', deviceIds: [], phase: 'appeared' }),
  },
  'device-becomes': {
    kind: 'device-becomes',
    category: 'devices',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.device-becomes',
    keywords: ['device', 'value', 'changes', 'turns', 'on', 'off', 'above', 'below', 'state'],
    needsDeviceValue: true,
    seed: () => ({ kind: 'device-becomes', deviceId: 0, cap: '', fieldPath: '' }),
  },
  'device-event': {
    kind: 'device-event',
    category: 'events',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.device-event',
    keywords: ['event', 'system', 'button', 'press', 'doorbell', 'alarm', 'category'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'device-event', category: '' }),
  },
  schedule: {
    kind: 'schedule',
    category: 'time',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.schedule',
    keywords: ['time', 'clock', 'daily', 'cron', 'sunrise', 'sunset', 'at', 'weekday'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'schedule', cron: '0 30 23 * * *' }),
  },
  interval: {
    kind: 'interval',
    category: 'time',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.interval',
    keywords: ['time', 'every', 'minutes', 'repeat', 'periodic', 'timer'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'interval', minutes: 5 }),
  },
  manual: {
    kind: 'manual',
    category: 'system',
    role: 'event',
    allowedIn: EVENT_CONTEXTS,
    i18nKey: 'automation.leafCatalog.manual',
    keywords: ['run', 'button', 'hand', 'test', 'on demand'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'manual' }),
  },
  'device-is': {
    kind: 'device-is',
    category: 'devices',
    role: 'state',
    allowedIn: STATE_CONTEXTS,
    i18nKey: 'automation.leafCatalog.device-is',
    keywords: ['device', 'value', 'is', 'equals', 'above', 'below', 'held', 'stable', 'for'],
    needsDeviceValue: true,
    seed: () => ({
      kind: 'device-is',
      deviceId: 0,
      cap: '',
      fieldPath: '',
      operator: 'eq',
      value: '',
    }),
  },
  'stationary-present': {
    kind: 'stationary-present',
    category: 'cameras',
    role: 'state',
    allowedIn: STATE_CONTEXTS,
    i18nKey: 'automation.leafCatalog.stationary-present',
    keywords: ['camera', 'parked', 'present', 'car', 'object', 'still there'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'stationary-present', deviceId: 0 }),
  },
  'time-is': {
    kind: 'time-is',
    category: 'time',
    role: 'state',
    allowedIn: STATE_CONTEXTS,
    i18nKey: 'automation.leafCatalog.time-is',
    keywords: ['time', 'hour', 'window', 'between', 'night', 'day', 'weekday', 'sunset', 'sunrise'],
    needsDeviceValue: false,
    seed: () => ({
      kind: 'time-is',
      between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
    }),
  },
  'triggered-by': {
    kind: 'triggered-by',
    category: 'logic',
    role: 'state',
    allowedIn: STATE_CONTEXTS,
    i18nKey: 'automation.leafCatalog.triggered-by',
    keywords: ['trigger', 'triggered', 'started', 'which', 'branch', 'fired'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'triggered-by', leafIds: [] }),
  },
  expression: {
    kind: 'expression',
    category: 'logic',
    role: 'state',
    allowedIn: STATE_CONTEXTS,
    i18nKey: 'automation.leafCatalog.expression',
    keywords: ['formula', 'math', 'arithmetic', 'sum', 'compare', 'calculate', 'held'],
    needsDeviceValue: false,
    seed: () => ({ kind: 'expression', expr: '', bindings: {} }),
  },
}

/** Every kind in display order: events first, then states. */
export const AUTOMATION_LEAF_KINDS: readonly AutomationLeafKind[] = [
  'detection',
  'stationary',
  'device-becomes',
  'device-event',
  'schedule',
  'interval',
  'manual',
  'device-is',
  'stationary-present',
  'time-is',
  'triggered-by',
  'expression',
]

export function leafCatalogEntry(kind: AutomationLeafKind): AutomationLeafCatalogEntry {
  return AUTOMATION_LEAF_CATALOG[kind]
}

/** A blank row of one kind. */
export function seedLeaf(kind: AutomationLeafKind): AutomationLeaf {
  return AUTOMATION_LEAF_CATALOG[kind].seed()
}

/** The kinds a context may add, in display order. */
export function leafKindsFor(context: AutomationLeafContext): readonly AutomationLeafKind[] {
  return AUTOMATION_LEAF_KINDS.filter((kind) =>
    AUTOMATION_LEAF_CATALOG[kind].allowedIn.includes(context),
  )
}
