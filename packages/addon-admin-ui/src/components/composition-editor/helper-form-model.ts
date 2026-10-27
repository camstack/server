/**
 * Build-your-self helper form (D944 phase 1a). The draft is a template —
 * reducer, name, room, members — and `compileHelper` is the only writer.
 * A composition with no `helper` stays a free expression.
 */
import {
  type ActiveCriterion,
  type AggregateReducer,
  APPLIANCE_DEFAULTS,
  APPLIANCE_TEMPLATE_ID,
  type ApplianceKind,
  type Composition,
  type CompositionProblem,
  compileHelper,
  GroupCommandsSchema,
  type GroupHelperSpec,
  type GroupTemplate,
  type GroupTemplateId,
  groupTemplate,
  type HelperCompileResult,
  type HelperMember,
  type HelperSpec,
  type IntegralHelperSpec,
  MAX_HELPER_MEMBERS,
  type ResetPeriod,
  reducerForActive,
  sharedColorModes,
  sharedLightCaps,
  type SourcePickRequest,
  sourcePickForAppliance,
  sourcePickForHistory,
  sourcePickForTemplate,
  type StatisticHelperSpec,
  type StatisticStat,
  type StatisticWindow,
} from '@camstack/types'

export type HelperPickerId = GroupTemplateId | typeof APPLIANCE_TEMPLATE_ID

export type HelperTemplateGroupId = 'readings' | 'binary' | 'actuators' | 'appliances'

export interface HelperTemplateGroup {
  readonly id: HelperTemplateGroupId
  readonly templateIds: readonly HelperPickerId[]
}

export interface HelperFormDraft {
  readonly kind: 'group'
  readonly templateId: HelperPickerId
  readonly aggregate: AggregateReducer
  /** Set on an actuator template. Readings leave it null. */
  readonly active: ActiveCriterion | null
  /** Set on the appliance template. Groups leave it null. */
  readonly appliance: ApplianceKind | null
  readonly thresholdWatts: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
  readonly name: string
  readonly room: string
  readonly members: readonly HelperMember[]
}

export interface StatisticFormDraft {
  readonly kind: 'statistic'
  readonly stat: StatisticStat
  readonly window: StatisticWindow
  readonly name: string
  readonly room: string
  readonly source: HelperMember | null
}

export interface IntegralFormDraft {
  readonly kind: 'integral'
  readonly reset: ResetPeriod
  readonly name: string
  readonly room: string
  readonly source: HelperMember | null
}

export type HelperDraft = HelperFormDraft | StatisticFormDraft | IntegralFormDraft

export type HelperTemplatePick =
  | { readonly kind: 'group'; readonly templateId: GroupTemplateId }
  | { readonly kind: 'appliance' }
  | { readonly kind: 'statistic' }
  | { readonly kind: 'integral' }

export interface RefusalLine {
  readonly path: string
  readonly code: string
  readonly message: string
}

export type SnapshotRead =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'answered'
      readonly caps: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>
    }

export type OutputReading =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number; readonly unit: string | undefined }
  | { readonly kind: 'boolean'; readonly value: boolean }

export type MemberCapRead =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready'
      readonly caps: readonly string[]
      readonly features: readonly string[]
    }

export type SharedCapsView =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly caps: readonly string[]; readonly modes: readonly string[] }

export interface CommandResultRow {
  readonly deviceId: number
  readonly cap: string
  readonly method: string
  readonly ok: boolean
  readonly error: string | null
  readonly at: number
}

export type CommandResultsView =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'rows'; readonly rows: readonly CommandResultRow[] }

export type GroupStatusRead =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'ready'
      readonly included: number
      readonly excluded: number
      readonly total: number
    }

export type MemberFieldState = 'pending' | 'error' | 'missing' | 'value' | 'empty'

export type MemberPresence = 'reporting' | 'excluded' | 'unknown'

export interface MemberLive {
  readonly name: string
  readonly presence: MemberPresence
}

export type ExcludedNames =
  | { readonly kind: 'pending' }
  | { readonly kind: 'named'; readonly names: readonly string[] }

const READINGS: readonly GroupTemplateId[] = [
  'temperature',
  'humidity',
  'pressure',
  'illuminance',
  'power',
  'energy',
  'battery',
  'numeric',
]

const BINARY: readonly GroupTemplateId[] = [
  'motion',
  'contact',
  'leak',
  'smoke',
  'occupancy',
  'binary',
]

const ACTUATORS: readonly GroupTemplateId[] = ['switch', 'light']

const APPLIANCES: readonly HelperPickerId[] = [APPLIANCE_TEMPLATE_ID]

const REFUSAL_MARKER = 'was refused — '
const REFUSAL_PART = /^(.+?) \[([a-z0-9-]+)\]: (.+)$/

export function helperTemplateGroups(): readonly HelperTemplateGroup[] {
  return [
    { id: 'readings', templateIds: READINGS },
    { id: 'binary', templateIds: BINARY },
    { id: 'actuators', templateIds: ACTUATORS },
    { id: 'appliances', templateIds: APPLIANCES },
  ]
}

const NO_APPLIANCE = {
  appliance: null,
  thresholdWatts: 0,
  startDwellMs: 0,
  stopDwellMs: 0,
} as const

export function draftForTemplate(templateId: HelperPickerId): HelperFormDraft | null {
  if (templateId === APPLIANCE_TEMPLATE_ID) {
    const defaults = APPLIANCE_DEFAULTS.washer
    return {
      kind: 'group',
      templateId,
      aggregate: 'any',
      active: null,
      appliance: 'washer',
      thresholdWatts: defaults.thresholdWatts,
      startDwellMs: defaults.startDwellMs,
      stopDwellMs: defaults.stopDwellMs,
      name: '',
      room: '',
      members: [],
    }
  }
  const template = groupTemplate(templateId)
  if (template === null) return null
  return {
    kind: 'group',
    templateId,
    aggregate: template.defaultAggregate,
    active: template.family === 'actuator' ? 'at-least-one' : null,
    ...NO_APPLIANCE,
    name: '',
    room: '',
    members: [],
  }
}

export function draftForPick(pick: HelperTemplatePick): HelperDraft | null {
  if (pick.kind === 'group') return draftForTemplate(pick.templateId)
  if (pick.kind === 'appliance') return draftForTemplate(APPLIANCE_TEMPLATE_ID)
  if (pick.kind === 'statistic') {
    return {
      kind: 'statistic',
      stat: 'mean',
      window: { kind: 'rolling', span: '24h' },
      name: '',
      room: '',
      source: null,
    }
  }
  return {
    kind: 'integral',
    reset: 'daily',
    name: '',
    room: '',
    source: null,
  }
}

export function draftFromHelper(spec: HelperSpec, name: string, room: string): HelperDraft | null {
  if (spec.kind === 'appliance') {
    return {
      kind: 'group',
      templateId: APPLIANCE_TEMPLATE_ID,
      aggregate: 'any',
      active: null,
      appliance: spec.appliance,
      thresholdWatts: spec.thresholdWatts,
      startDwellMs: spec.startDwellMs,
      stopDwellMs: spec.stopDwellMs,
      name,
      room,
      members: [copyMember(spec.member)],
    }
  }
  if (spec.kind === 'statistic') {
    return {
      kind: 'statistic',
      stat: spec.stat,
      window: spec.window,
      name,
      room,
      source: copyMember(spec.source),
    }
  }
  if (spec.kind === 'integral') {
    return { kind: 'integral', reset: spec.reset, name, room, source: copyMember(spec.source) }
  }
  const template = groupTemplate(spec.templateId)
  if (template === null || !template.aggregates.includes(spec.aggregate)) return null
  if (template.family === 'actuator' && spec.active === undefined) return null
  if (template.family !== 'actuator' && spec.active !== undefined) return null
  return {
    kind: 'group',
    templateId: spec.templateId,
    aggregate: spec.aggregate,
    active: spec.active ?? null,
    ...NO_APPLIANCE,
    name,
    room,
    members: spec.members.map(copyMember),
  }
}

export function isHelperComposition(
  composition: Composition,
): composition is Composition & { readonly helper: HelperSpec } {
  return composition.helper !== undefined
}

export function withAggregate(
  draft: HelperFormDraft,
  aggregate: AggregateReducer,
): HelperFormDraft {
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return draft
  const template = groupTemplate(draft.templateId)
  if (template === null || !template.aggregates.includes(aggregate)) return draft
  return { ...draft, aggregate }
}

export function withActive(draft: HelperFormDraft, active: ActiveCriterion): HelperFormDraft {
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return draft
  const template = groupTemplate(draft.templateId)
  if (template === null || template.family !== 'actuator') return draft
  return { ...draft, active, aggregate: reducerForActive(active) }
}

export function withName(draft: HelperDraft, name: string): HelperDraft {
  return { ...draft, name }
}

export function withRoom(draft: HelperFormDraft, room: string): HelperFormDraft {
  return { ...draft, room }
}

/**
 * The same template keeps every choice. A different template starts over:
 * name, operation, criterion and members belong to the template that was open.
 */
export function withTemplate(draft: HelperFormDraft, templateId: HelperPickerId): HelperFormDraft {
  if (templateId === draft.templateId) return draft
  return draftForTemplate(templateId) ?? draft
}

/** A different appliance type starts from that type's dwells. */
export function withAppliance(draft: HelperFormDraft, kind: ApplianceKind): HelperFormDraft {
  if (draft.templateId !== APPLIANCE_TEMPLATE_ID) return draft
  const defaults = APPLIANCE_DEFAULTS[kind]
  return {
    ...draft,
    appliance: kind,
    thresholdWatts: defaults.thresholdWatts,
    startDwellMs: defaults.startDwellMs,
    stopDwellMs: defaults.stopDwellMs,
  }
}

export type HelperSaveIntent = 'open' | 'again'

export type HelperSaveResult =
  | { readonly kind: 'saved'; readonly deviceId: number }
  | { readonly kind: 'refused'; readonly lines: readonly RefusalLine[] }

export function memberRequest(draft: HelperDraft): SourcePickRequest | null {
  if (draft.kind === 'statistic' || draft.kind === 'integral')
    return sourcePickForHistory(draft.kind)
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return sourcePickForAppliance()
  const template = groupTemplate(draft.templateId)
  if (template === null) return null
  return sourcePickForTemplate(template)
}

export function specFromDraft(draft: HelperDraft): HelperSpec | null {
  if (draft.kind === 'statistic') return statisticSpec(draft)
  if (draft.kind === 'integral') return integralSpec(draft)
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return applianceSpec(draft)
  return groupSpec(draft)
}

function applianceSpec(draft: HelperFormDraft): HelperSpec | null {
  const member = draft.members[0]
  if (member === undefined || draft.appliance === null) return null
  return {
    kind: 'appliance',
    templateId: APPLIANCE_TEMPLATE_ID,
    appliance: draft.appliance,
    thresholdWatts: draft.thresholdWatts,
    startDwellMs: draft.startDwellMs,
    stopDwellMs: draft.stopDwellMs,
    member: copyMember(member),
  }
}

function groupSpec(draft: HelperFormDraft): GroupHelperSpec | null {
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return null
  const template = groupTemplate(draft.templateId)
  const actuator = template?.family === 'actuator' && draft.active !== null
  return {
    kind: 'group',
    templateId: draft.templateId,
    aggregate: actuator && draft.active !== null ? reducerForActive(draft.active) : draft.aggregate,
    ...(actuator && draft.active !== null ? { active: draft.active } : {}),
    members: draft.members.map(copyMember),
  }
}

const MISSING_MEMBER: CompositionProblem = {
  code: 'member-constraint',
  path: 'helper.member',
  message: 'an appliance helper needs one power reading',
}

const MISSING_HISTORY: CompositionProblem = {
  code: 'member-constraint',
  path: 'helper.source',
  message: 'pick one reading that declares history',
}

export function compileDraft(draft: HelperDraft): HelperCompileResult {
  const spec = specFromDraft(draft)
  if (spec === null) {
    const missing =
      draft.kind === 'group' && draft.templateId === APPLIANCE_TEMPLATE_ID
        ? MISSING_MEMBER
        : MISSING_HISTORY
    return { ok: false, problems: [missing] }
  }
  return compileHelper(spec)
}

/** Compile, then write. A thrown server refusal comes back as its named lines. */
export async function writeHelper(
  draft: HelperDraft,
  write: (composition: Composition, name: string) => Promise<void>,
): Promise<readonly RefusalLine[]> {
  const compiled = compileDraft(draft)
  if (!compiled.ok) return refusalLines(compiled.problems)
  try {
    await write(compiled.composition, draft.name.trim())
    return []
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return refusalFromMessage(message)
  }
}

export function canSaveDraft(draft: HelperDraft): boolean {
  if (draft.kind === 'statistic' || draft.kind === 'integral') return draft.source !== null
  if (draft.templateId === APPLIANCE_TEMPLATE_ID) return draft.members.length === 1
  return draft.members.length >= 1 && draft.members.length <= MAX_HELPER_MEMBERS
}

export function refusalLines(problems: readonly CompositionProblem[]): readonly RefusalLine[] {
  return problems.map((problem) => ({
    path: problem.path,
    code: problem.code,
    message: problem.message,
  }))
}

/** Pull `path [code]: message` out of a core-blocks refusal. The text is the reason. */
export function refusalFromMessage(text: string): readonly RefusalLine[] {
  const markerAt = text.indexOf(REFUSAL_MARKER)
  const body = markerAt === -1 ? text : text.slice(markerAt + REFUSAL_MARKER.length)
  const parsed = body.split(/; (?=[^;]*\[[a-z0-9-]+\]:)/).flatMap(parseRefusalPart)
  if (parsed.length > 0) return parsed
  return [{ path: '', code: 'refused', message: text }]
}

export function outputReading(read: SnapshotRead, template: GroupTemplate): OutputReading {
  if (read.kind === 'pending') return { kind: 'pending' }
  if (read.kind === 'error') return { kind: 'unavailable', message: read.message }
  const slice = read.caps[template.outputCap]
  if (slice === undefined) return { kind: 'empty' }
  const value = slice[template.outputField]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'number', value, unit: template.baseUnit }
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value }
  return { kind: 'empty' }
}

export function groupStatusFromSnapshot(read: SnapshotRead): GroupStatusRead {
  if (read.kind === 'pending') return { kind: 'pending' }
  if (read.kind === 'error') return { kind: 'unavailable', message: read.message }
  const slice = read.caps['group-status']
  if (slice === undefined) return { kind: 'absent' }
  const included = countField(slice.included)
  const excluded = countField(slice.excluded)
  const total = countField(slice.total)
  if (included === null || excluded === null || total === null) return { kind: 'absent' }
  return { kind: 'ready', included, excluded, total }
}

/** Optional light controls, only once every member's bindings have answered. */
export function sharedCapsView(reads: readonly MemberCapRead[]): SharedCapsView {
  if (reads.length === 0 || reads.some((read) => read.kind === 'pending'))
    return { kind: 'pending' }
  if (reads.some((read) => read.kind === 'error')) return { kind: 'unavailable' }
  const ready = reads.flatMap((read) => (read.kind === 'ready' ? [read] : []))
  const caps = sharedLightCaps(ready.map((read) => read.caps))
  const modes = caps.includes('color') ? sharedColorModes(ready.map((read) => read.features)) : []
  return { kind: 'ready', caps: [...caps], modes: [...modes] }
}

export function commandResultsFromSnapshot(read: SnapshotRead): CommandResultsView {
  if (read.kind === 'pending') return { kind: 'pending' }
  if (read.kind === 'error') return { kind: 'unavailable', message: read.message }
  const slice = read.caps['group-commands']
  if (slice === undefined) return { kind: 'none' }
  const parsed = GroupCommandsSchema.safeParse(slice)
  if (!parsed.success) return { kind: 'unavailable', message: 'group-commands' }
  if (parsed.data.results.length === 0) return { kind: 'none' }
  return {
    kind: 'rows',
    rows: parsed.data.results.map((row) => ({
      deviceId: row.deviceId,
      cap: row.cap,
      method: row.method,
      ok: row.ok,
      error: row.error ?? null,
      at: row.at,
    })),
  }
}

export function fieldStateOf(
  status: 'pending' | 'error' | 'success',
  caps: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | undefined,
  cap: string,
  fieldPath: string,
): MemberFieldState {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'error'
  const slice = caps?.[cap]
  if (slice === undefined) return 'missing'
  const value = slice[fieldPath]
  if (typeof value === 'number' && Number.isFinite(value)) return 'value'
  if (typeof value === 'boolean') return 'value'
  if (value === undefined) return 'missing'
  return 'empty'
}

export function memberPresence(input: {
  readonly fleet: 'pending' | 'error' | 'answered'
  readonly deviceOnline: boolean | null
  readonly field: MemberFieldState
}): MemberPresence {
  if (input.fleet !== 'answered') return 'unknown'
  if (input.deviceOnline === null || input.deviceOnline === false) return 'excluded'
  if (input.field === 'pending' || input.field === 'error') return 'unknown'
  if (input.field === 'value') return 'reporting'
  return 'excluded'
}

/** Unanswered members stay unnamed (D315). A complete answer names who is out. */
export function namedExcluded(members: readonly MemberLive[]): ExcludedNames {
  if (members.some((member) => member.presence === 'unknown')) return { kind: 'pending' }
  return {
    kind: 'named',
    names: members.flatMap((member) => (member.presence === 'excluded' ? [member.name] : [])),
  }
}

export function snapshotCaps(
  data: unknown,
): Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> {
  if (!isRecord(data)) return {}
  const caps: Record<string, Readonly<Record<string, unknown>> | undefined> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isRecord(value)) caps[key] = value
  }
  return caps
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statisticSpec(draft: StatisticFormDraft): StatisticHelperSpec | null {
  if (draft.source === null) return null
  return {
    kind: 'statistic',
    stat: draft.stat,
    window: copyWindow(draft.window),
    source: copyMember(draft.source),
  }
}

function integralSpec(draft: IntegralFormDraft): IntegralHelperSpec | null {
  if (draft.source === null) return null
  const watts = draft.source.cap === 'power-meter' && draft.source.fieldPath === 'watts'
  return {
    kind: 'integral',
    reset: draft.reset,
    output: watts ? 'energy' : 'meter',
    source: copyMember(draft.source),
  }
}

function copyWindow(window: StatisticWindow): StatisticWindow {
  if (window.kind === 'calendar') return { kind: 'calendar', period: window.period }
  if (window.customMinutes === undefined) return { kind: 'rolling', span: window.span }
  return { kind: 'rolling', span: window.span, customMinutes: window.customMinutes }
}

function copyMember(member: HelperMember): HelperMember {
  return {
    source: { addonId: member.source.addonId, stableId: member.source.stableId },
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}

function countField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function parseRefusalPart(part: string): readonly RefusalLine[] {
  const match = REFUSAL_PART.exec(part.trim())
  if (match === null) return []
  const path = match[1]
  const code = match[2]
  const message = match[3]
  if (path === undefined || code === undefined || message === undefined) return []
  return [{ path, code, message }]
}
