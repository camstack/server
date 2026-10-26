/**
 * Build-your-self helper form (D944 phase 1a). The draft is a template —
 * reducer, name, room, members — and `compileHelper` is the only writer.
 * A composition with no `helper` stays a free expression.
 */
import {
  type AggregateReducer,
  type Composition,
  type CompositionProblem,
  compileHelper,
  type GroupHelperSpec,
  type GroupTemplate,
  type GroupTemplateId,
  groupTemplate,
  type HelperCompileResult,
  type HelperMember,
  type HelperSpec,
  MAX_HELPER_MEMBERS,
  type SourcePickRequest,
  sourcePickForTemplate,
} from '@camstack/types'

export type HelperTemplateGroupId = 'readings' | 'binary'

export interface HelperTemplateGroup {
  readonly id: HelperTemplateGroupId
  readonly templateIds: readonly GroupTemplateId[]
}

export interface HelperFormDraft {
  readonly templateId: GroupTemplateId
  readonly aggregate: AggregateReducer
  readonly name: string
  readonly room: string
  readonly members: readonly HelperMember[]
}

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

const REFUSAL_MARKER = 'was refused — '
const REFUSAL_PART = /^(.+?) \[([a-z0-9-]+)\]: (.+)$/

export function helperTemplateGroups(): readonly HelperTemplateGroup[] {
  return [
    { id: 'readings', templateIds: READINGS },
    { id: 'binary', templateIds: BINARY },
  ]
}

export function draftForTemplate(templateId: GroupTemplateId): HelperFormDraft | null {
  const template = groupTemplate(templateId)
  if (template === null) return null
  return {
    templateId,
    aggregate: template.defaultAggregate,
    name: '',
    room: '',
    members: [],
  }
}

export function draftFromHelper(
  spec: HelperSpec,
  name: string,
  room: string,
): HelperFormDraft | null {
  const template = groupTemplate(spec.templateId)
  if (template === null || !template.aggregates.includes(spec.aggregate)) return null
  return {
    templateId: spec.templateId,
    aggregate: spec.aggregate,
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
  const template = groupTemplate(draft.templateId)
  if (template === null || !template.aggregates.includes(aggregate)) return draft
  return { ...draft, aggregate }
}

export function withName(draft: HelperFormDraft, name: string): HelperFormDraft {
  return { ...draft, name }
}

export function withRoom(draft: HelperFormDraft, room: string): HelperFormDraft {
  return { ...draft, room }
}

/** A new template keeps the name and room and drops the previous members. */
export function withTemplate(draft: HelperFormDraft, templateId: GroupTemplateId): HelperFormDraft {
  if (templateId === draft.templateId) return draft
  const next = draftForTemplate(templateId)
  if (next === null) return draft
  return { ...next, name: draft.name, room: draft.room }
}

export function memberRequest(draft: HelperFormDraft): SourcePickRequest | null {
  const template = groupTemplate(draft.templateId)
  if (template === null) return null
  return sourcePickForTemplate(template)
}

export function specFromDraft(draft: HelperFormDraft): GroupHelperSpec {
  return {
    kind: 'group',
    templateId: draft.templateId,
    aggregate: draft.aggregate,
    members: draft.members.map(copyMember),
  }
}

export function compileDraft(draft: HelperFormDraft): HelperCompileResult {
  return compileHelper(specFromDraft(draft))
}

/** Compile, then write. A thrown server refusal comes back as its named lines. */
export async function writeHelper(
  draft: HelperFormDraft,
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

export function canSaveDraft(draft: HelperFormDraft): boolean {
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
