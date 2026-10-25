/**
 * Save-time validation of a composition (D659): shape, capability fit, field
 * kinds, nullability, sources, cycles — and on an EXISTING target (D663),
 * add vs replace per feature, self reads, one composition per device. Every refusal names its reason (D391),
 * and every variant a later slice implements is refused BY NAME with that slice.
 *
 * Pure: the caller DESCRIBES the sources and an existing target (one read
 * each) and passes the other stored compositions. `planComposition` is the static half the composer
 * re-runs at apply time, where the sources are the tracker's business.
 */
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import type { z } from 'zod'
import type { DeviceType } from '../device/device-type.js'
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  COMPOSER_ADDON_ID,
  type Composition,
  type CompositionFieldRead,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  compositionFeatureEnabled,
  compositionSourceKey,
  featureSources,
  fieldReads,
} from './composition.js'
import { planItems } from './composition-items.js'
import {
  compatibility,
  enumLiteralProblem,
  roleOf,
  sourceKinds,
  unavailableFor,
} from './field-kinds.js'
import { type CompositionPlanResult, compositionFieldAt, problem, refused } from './plan-result.js'
import {
  CompositionGraphError,
  type CompositionPeer,
  findCandidateCycles,
} from './composition-graph.js'
import {
  type CompositionFeatureMode,
  type CompositionFieldPlan,
  type CompositionProblem,
  type CompositionValidation,
  compositionFieldKey,
} from './composition-report.js'
import { planCompositionEvents } from './composition-events.js'
import {
  describeTopLevelStateFields,
  requiredTopLevelKeys,
  type StateFieldDescription,
} from './state-fields.js'

export type CapabilityLookup = (capName: string) => CapabilityDefinition | null

export function buildCapabilityLookup(defs: readonly CapabilityDefinition[]): CapabilityLookup {
  const byName = new Map(defs.map((d) => [d.name, d]))
  return (capName) => byName.get(capName) ?? null
}

/** Caps every `BaseDevice` registers on itself; a second registration throws. */
export const BASE_DEVICE_CAPS: ReadonlySet<string> = new Set(['device-status', 'feature-probe'])

export interface CompositionSourceFound {
  readonly kind: 'found'
  readonly deviceId: number
  readonly caps: ReadonlySet<string>
}
export interface CompositionSourceAbsent {
  readonly kind: 'absent'
}
export interface CompositionSourceUnreadable {
  readonly kind: 'unreadable'
  readonly error: string
}
export type CompositionSourceDescription =
  | CompositionSourceFound
  | CompositionSourceAbsent
  | CompositionSourceUnreadable

/** An existing target device, read once: its type and each cap bound to it, with the addon serving it. */
export interface CompositionTargetFound {
  readonly kind: 'found'
  readonly deviceId: number
  readonly type: DeviceType
  /** cap name → `nativeAddonId` (`getBindings`). A cap the composer grafted carries `COMPOSER_ADDON_ID`. */
  readonly nativeCaps: ReadonlyMap<string, string>
}
export type CompositionTargetDescription =
  | CompositionTargetFound
  | CompositionSourceAbsent
  | CompositionSourceUnreadable

export interface ValidateCompositionContext {
  readonly lookupCap: CapabilityLookup
  /** Keyed by `compositionSourceKey`. A ref with no entry was not read, and is refused as unreadable. */
  readonly sources: ReadonlyMap<string, CompositionSourceDescription>
  /** The device this composition writes; null on create, when the block has no id yet. */
  readonly self: CompositionSourceRef | null
  /** The block being saved; null on create. Its stored old version is recognised by this id (D663). */
  readonly blockId: string | null
  /** The EXISTING target device, read once; null for a new-device composition (a missing read is refused). */
  readonly target: CompositionTargetDescription | null
  /** Every OTHER stored composition; cycles run through them. */
  readonly peers: readonly CompositionPeer[]
  /**
   * Devices of stored customizations whose target could not be read, by
   * `compositionSourceKey` → why. Their peers are OVER-approximated (nothing
   * `replaced`, so every self-read is an edge — edges are only added, a cycle
   * never hidden). A cyclic component holding a candidate node and such a
   * device refuses NAMING the device ("possible cycle"); a component without a
   * candidate node is never this save's cycle (`findCandidateCycles`).
   */
  readonly unreadTargets?: ReadonlyMap<string, string>
}

export type { CompositionPlanResult } from './plan-result.js'

const PENDING_SELF: CompositionSourceRef = {
  addonId: COMPOSER_ADDON_ID,
  stableId: `${COMPOSED_DEVICE_STABLE_ID_PREFIX}(unsaved)`,
}

/** The candidate's block id before its first save. Stored block ids are `randomUUID()`, so none can carry it. */
export const PENDING_BLOCK_ID = '(unsaved)'

/** What a feature is planned against: its mode and the type of the device it lands on. */
interface FeatureTarget {
  readonly mode: CompositionFeatureMode
  readonly deviceType: DeviceType
}

interface ComposableCap {
  readonly def: CapabilityDefinition
  readonly state: z.ZodType
  /** The cap's top-level state fields, described once per feature. */
  readonly fields: ReadonlyMap<string, StateFieldDescription>
}

function composableCap(
  feature: CompositionFieldsFeature,
  at: string,
  lookupCap: CapabilityLookup,
): ComposableCap | CompositionProblem {
  const def = lookupCap(feature.cap)
  if (def === null)
    return problem('unknown-capability', `${at}.cap`, `no capability is named \`${feature.cap}\``)
  if (BASE_DEVICE_CAPS.has(def.name)) {
    return problem(
      'not-composable',
      `${at}.cap`,
      `\`${def.name}\` is registered by every device itself — it cannot be composed`,
    )
  }
  const state = def.runtimeState
  if (def.scope !== 'device' || state === undefined) {
    return problem(
      'not-composable',
      `${at}.cap`,
      `\`${def.name}\` has no per-device state to compose`,
    )
  }
  return { def, state, fields: describeTopLevelStateFields(state) }
}

/**
 * A capability BUILT by the composition (a new device, or one ADDED to an
 * existing device) must fit the device type, serve no command, and have every
 * required field. A REPLACE needs none of it: the cap is bound (a fact), the
 * native keeps serving its methods, and only the named fields are owned (D663).
 */
function builtCapProblems(
  { def, state, fields: targetFields }: ComposableCap,
  feature: CompositionFieldsFeature,
  at: string,
  deviceType: DeviceType,
): readonly CompositionProblem[] {
  const problems: CompositionProblem[] = []
  if (def.deviceTypes !== undefined && !def.deviceTypes.includes(deviceType)) {
    problems.push(
      problem(
        'wrong-device-type',
        `${at}.cap`,
        `\`${def.name}\` is not offered on a \`${deviceType}\` device (it allows ${def.deviceTypes.join(', ')})`,
      ),
    )
  }
  const served = Object.entries(def.methods)
    .filter(([name, m]) => m.systemOnly !== true && def.composedMethods?.[name] === undefined)
    .map(([name]) => `\`${name}\``)
  if (served.length > 0) {
    problems.push(
      problem(
        'has-commands',
        `${at}.cap`,
        `\`${def.name}\` has ${served.join(', ')}, which a composed device cannot serve until commands arrive (slice 3)`,
      ),
    )
  }
  // A composition that names `items` owns the whole item array (planItems).
  const itemArrayPath = feature.items === undefined ? null : (def.status?.itemArray?.path ?? null)
  for (const key of requiredTopLevelKeys(state)) {
    if (key === itemArrayPath) continue
    if (!targetFields.has(key)) {
      problems.push(
        problem(
          'not-composable',
          `${at}.fields`,
          `\`${def.name}.${key}\` is not a scalar — nested fields arrive in a later slice`,
        ),
      )
    } else if (!(key in feature.fields)) {
      problems.push(
        problem(
          'missing-field',
          `${at}.fields.${key}`,
          `\`${def.name}.${key}\` is required and has no source`,
        ),
      )
    }
  }
  return problems
}

/** Which of a feature's fields is being planned. */
interface TopLevelField {
  readonly featureIndex: number
  readonly path: string
  readonly source: CompositionFieldSource
}

function planTopLevelField(
  { def, fields }: ComposableCap,
  field: TopLevelField,
  mode: CompositionFeatureMode,
  lookupCap: CapabilityLookup,
): CompositionPlanResult {
  const { featureIndex, path, source } = field
  const fieldAt = `features[${featureIndex}].fields.${path}`
  if (path.includes('.'))
    return refused(
      problem(
        'nested-field',
        fieldAt,
        `\`${path}\` is nested — nested fields arrive in a later slice`,
      ),
    )
  const tf = fields.get(path)
  if (tf === undefined)
    return refused(problem('unknown-field', fieldAt, `\`${def.name}\` has no field \`${path}\``))
  const kinds = sourceKinds(source, lookupCap)
  if (!kinds.ok) return refused(problem(kinds.code, fieldAt, kinds.message))
  const role = roleOf(source)
  const unavailable = unavailableFor(tf, role, mode, def.name, fieldAt)
  if (!unavailable.ok) return refused(unavailable.problem)
  const plan: CompositionFieldPlan = {
    cap: def.name,
    path,
    featureIndex,
    kind: tf.kind,
    nullable: tf.nullable,
    required: tf.required,
    unavailable: unavailable.unavailable,
    role,
    source,
    reads: [...fieldReads(source)],
  }
  const enumProblem = enumLiteralProblem(def.name, tf, source, fieldAt)
  return {
    problems: [
      ...compatibility(def.name, tf, kinds.kinds, fieldAt),
      ...(enumProblem === null ? [] : [enumProblem]),
    ],
    fields: [plan],
    features: [],
    events: [],
  }
}

function planFeature(
  feature: CompositionFieldsFeature,
  featureIndex: number,
  target: FeatureTarget,
  lookupCap: CapabilityLookup,
): CompositionPlanResult {
  const at = `features[${featureIndex}]`
  const cap = composableCap(feature, at, lookupCap)
  if ('code' in cap) return refused(cap)
  const capProblems: CompositionProblem[] =
    target.mode === 'replace' ? [] : [...builtCapProblems(cap, feature, at, target.deviceType)]
  if (feature.commands !== undefined && Object.keys(feature.commands).length > 0) {
    capProblems.push(
      problem('reserved-variant', `${at}.commands`, 'commands (`forward`) arrive in slice 3'),
    )
  }
  const perField = Object.entries(feature.fields).map(([path, source]) =>
    planTopLevelField(cap, { featureIndex, path, source }, target.mode, lookupCap),
  )
  const items: readonly CompositionPlanResult[] =
    feature.items === undefined
      ? []
      : [planItems(cap.def, feature, featureIndex, lookupCap, target.mode)]
  const all = [...perField, ...items]
  const fields = all.flatMap((result) => result.fields)
  const featurePlan = { featureIndex, cap: cap.def.name, mode: target.mode } as const
  const eventPlan = planCompositionEvents(cap.def, featurePlan, fields)
  return {
    problems: [...capProblems, ...all.flatMap((r) => r.problems), ...eventPlan.problems],
    fields,
    features: [featurePlan],
    events: eventPlan.events,
  }
}

/** A cap the device serves itself; one the composer grafted (an earlier ADD) is not native. */
function isNativeCap(target: CompositionTargetFound, cap: string): boolean {
  const owner = target.nativeCaps.get(cap)
  return owner !== undefined && owner !== COMPOSER_ADDON_ID
}

/** What the features of a composition land on, once the target has been read. */
type PlanTarget =
  | { readonly kind: 'new'; readonly type: DeviceType }
  | { readonly kind: 'existing'; readonly found: CompositionTargetFound }

/** The target read, or the refusal that replaces the whole plan when it could not be (D391). */
function planTargetOf(
  composition: Composition,
  target: CompositionTargetDescription | undefined,
): PlanTarget | CompositionProblem {
  if (composition.target.kind === 'new') return { kind: 'new', type: composition.target.type }
  const key = compositionSourceKey(composition.target.device)
  if (target === undefined)
    return problem(
      'target-unreadable',
      'target',
      `target device \`${key}\` was not read — the save is refused rather than stored unchecked`,
    )
  if (target.kind === 'absent')
    return problem('target-missing', 'target', `target device \`${key}\` does not exist`)
  if (target.kind === 'unreadable')
    return problem(
      'target-unreadable',
      'target',
      `could not read target device \`${key}\` (${target.error}) — the save is refused rather than stored unchecked`,
    )
  return { kind: 'existing', found: target }
}

function featureTargetOf(target: PlanTarget, cap: string): FeatureTarget {
  if (target.kind === 'new') return { mode: 'new', deviceType: target.type }
  const mode = isNativeCap(target.found, cap) ? 'replace' : 'add'
  return { mode, deviceType: target.found.type }
}

/**
 * The static plan. `target` describes an EXISTING target device (one read);
 * it is ignored for a new one. On an existing target each feature REPLACES a
 * cap the device has natively, else ADDS it (D663).
 */
export function planComposition(
  composition: Composition,
  lookupCap: CapabilityLookup,
  target?: CompositionTargetDescription,
): CompositionPlanResult {
  const planTarget = planTargetOf(composition, target)
  if ('code' in planTarget) return refused(planTarget)
  const results = composition.features.map((feature, index): CompositionPlanResult => {
    const result =
      feature.kind === 'passthrough'
        ? refused(
            problem(
              'reserved-variant',
              `features[${index}]`,
              `whole-capability passthrough of \`${feature.cap}\` arrives in slice 3`,
            ),
          )
        : planFeature(feature, index, featureTargetOf(planTarget, feature.cap), lookupCap)
    return compositionFeatureEnabled(feature)
      ? result
      : { problems: result.problems, fields: [], features: [], events: [] }
  })
  return {
    problems: results.flatMap((r) => r.problems),
    fields: results.flatMap((r) => r.fields),
    features: results.flatMap((r) => r.features),
    events: results.flatMap((r) => r.events),
  }
}

export function compositionSourceRefs(composition: Composition): readonly CompositionSourceRef[] {
  const refs = composition.features.flatMap((f) =>
    compositionFeatureEnabled(f) && f.kind === 'fields'
      ? featureSources(f)
          .flatMap(fieldReads)
          .map((r) => r.source)
      : [],
  )
  return [...new Map(refs.map((r) => [compositionSourceKey(r), r])).values()]
}

/** The device the candidate writes, and what its own reads of that device mean. */
interface CandidateSelf {
  readonly ref: CompositionSourceRef
  /** The existing target, read; null for a new device. */
  readonly native: CompositionTargetFound | null
  /** `compositionFieldKey` of every field a REPLACE feature owns — reads of them are native (rule 5). */
  readonly replaced: ReadonlySet<string>
}

/**
 * The candidate's device: the existing target itself, else `self`, else a
 * placeholder that cannot collide with a stored target. An existing target is
 * known even on create, so a second customization of it is refused on create too.
 */
function candidateSelf(
  composition: Composition,
  ctx: ValidateCompositionContext,
  plan: CompositionPlanResult,
): CandidateSelf {
  const ref =
    composition.target.kind === 'existing' ? composition.target.device : (ctx.self ?? PENDING_SELF)
  const native =
    composition.target.kind === 'existing' && ctx.target?.kind === 'found' ? ctx.target : null
  return { ref, native, replaced: replacedFieldKeys(plan) }
}

/**
 * `compositionFieldKey` of every field a REPLACE feature of `plan` owns — the
 * candidate's own, and a stored peer's `CompositionPeer.replaced` (D663): one
 * derivation, so the graph reads both the same way.
 */
export function replacedFieldKeys(plan: CompositionPlanResult): ReadonlySet<string> {
  const replacing = new Set(
    plan.features.filter((f) => f.mode === 'replace').map((f) => f.featureIndex),
  )
  return new Set(plan.fields.filter((f) => replacing.has(f.featureIndex)).map(compositionFieldKey))
}

/**
 * A read of the candidate's own device. Its own composed output (a new device's
 * field, an ADDED field) is the slice-1 own-field rule; on an existing target
 * every other field — replaced, or not composed at all — is the NATIVE value,
 * valid when the device serves that cap natively (D663, rule 5).
 */
function selfReadProblems(
  read: CompositionFieldRead,
  at: string,
  fields: readonly CompositionFieldPlan[],
  self: CandidateSelf,
): readonly CompositionProblem[] {
  const readKey = `${read.cap}.${read.fieldPath}`
  const ownOutput = fields.some(
    (f) => compositionFieldKey(f) === readKey && !self.replaced.has(readKey),
  )
  if (ownOutput) return []
  if (self.native === null) {
    return [
      problem(
        'source-field-unknown',
        at,
        `this device has no composed field \`${read.cap}.${read.fieldPath}\``,
      ),
    ]
  }
  if (isNativeCap(self.native, read.cap)) return []
  return [
    problem(
      'source-capability-missing',
      at,
      `the target device (device ${self.native.deviceId}) has no native \`${read.cap}\``,
    ),
  ]
}

function sourceProblems(
  fields: readonly CompositionFieldPlan[],
  ctx: ValidateCompositionContext,
  self: CandidateSelf,
): readonly CompositionProblem[] {
  const selfKey = compositionSourceKey(self.ref)
  return fields.flatMap((field) =>
    field.reads.flatMap((read): readonly CompositionProblem[] => {
      const at = compositionFieldAt(field)
      const key = compositionSourceKey(read.source)
      if (key === selfKey) return selfReadProblems(read, at, fields, self)
      const desc = ctx.sources.get(key)
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
      if (!desc.caps.has(read.cap)) {
        return [
          problem(
            'source-capability-missing',
            at,
            `source \`${key}\` (device ${desc.deviceId}) has no \`${read.cap}\``,
          ),
        ]
      }
      return []
    }),
  )
}

/** One of the candidate's own fields, recovered from a cycle node key. */
interface CandidateField {
  readonly cap: string
  readonly fieldPath: string
}

/**
 * A cycle's node keys are `compositionReadKey` strings:
 * `<addonId>/<stableId>#<cap>.<fieldPath>`. When a node belongs to the
 * CANDIDATE itself (this composition being saved), pull its `cap`/`fieldPath`
 * back out so the refusal can point at that exact field, matching the
 * documented `features[N].fields.<path>` convention. A cap name has no `.`,
 * so splitting `rest` on the FIRST `.` is exact; an item leaf's remainder
 * (`items[desiccant].status`) is matched through `compositionFieldKey`.
 */
function candidateFieldOfNode(nodeKey: string, candidateKey: string): CandidateField | null {
  const prefix = `${candidateKey}#`
  if (!nodeKey.startsWith(prefix)) return null
  const rest = nodeKey.slice(prefix.length)
  const dot = rest.indexOf('.')
  if (dot === -1) return null
  return { cap: rest.slice(0, dot), fieldPath: rest.slice(dot + 1) }
}

/** The first node of a cycle's path that is one of THIS composition's own
 *  planned fields, as a documented-convention path; `'features'` when the
 *  cycle runs entirely through other stored compositions. */
function cyclePath(
  nodePath: readonly string[],
  candidateKey: string,
  fields: readonly CompositionFieldPlan[],
): string {
  for (const nodeKey of nodePath) {
    const hit = candidateFieldOfNode(nodeKey, candidateKey)
    if (hit === null) continue
    const hitKey = `${hit.cap}.${hit.fieldPath}`
    const field = fields.find((f) => compositionFieldKey(f) === hitKey)
    if (field !== undefined) return compositionFieldAt(field)
  }
  return 'features'
}

/** An unread device a cycle runs through, and why it was not read. */
interface UnreadDevice {
  readonly key: string
  readonly error: string
}

/** The first unread device any of `nodes` belongs to; null when none does. */
function unreadDeviceOf(
  nodes: readonly string[],
  unread: ReadonlyMap<string, string>,
): UnreadDevice | null {
  for (const [key, error] of unread) {
    if (nodes.some((node) => node.startsWith(`${key}#`))) return { key, error }
  }
  return null
}

/**
 * Cycle check runs against the CANDIDATE (this composition, as block
 * `ctx.blockId`, writing `self.ref`) plus every OTHER stored composition,
 * decided per strongly connected component (`findCandidateCycles`): a cyclic
 * component holding a candidate node refuses, with one representative cycle
 * through it; one without is not this save's cycle. A
 * stored composition of the same block is its old version; another block on
 * the same device, or two stored peers sharing a device, make
 * `compositionEdges` throw `CompositionGraphError` — refused BY NAME as
 * `duplicate-target` (D391, D663) instead of escaping as an uncaught throw.
 */
function cycleProblems(
  composition: Composition,
  ctx: ValidateCompositionContext,
  fields: readonly CompositionFieldPlan[],
  self: CandidateSelf,
): readonly CompositionProblem[] {
  const candidate: CompositionPeer = {
    blockId: ctx.blockId ?? PENDING_BLOCK_ID,
    target: self.ref,
    composition,
    replaced: self.replaced,
  }
  const candidateKey = compositionSourceKey(candidate.target)
  const unread = ctx.unreadTargets ?? new Map<string, string>()
  try {
    return findCandidateCycles(candidate, ctx.peers).map((c) => {
      const at = cyclePath(c.path, candidateKey, fields)
      const through = unreadDeviceOf([...c.component], unread)
      return through === null
        ? problem('cycle', at, `a field reads itself: ${c.path.join(' → ')}`)
        : problem(
            'cycle',
            at,
            `possible cycle through \`${through.key}\` — its state could not be read (${through.error}): ${c.path.join(' → ')}`,
          )
    })
  } catch (err: unknown) {
    if (err instanceof CompositionGraphError) {
      return [problem('duplicate-target', 'features', err.message)]
    }
    throw err
  }
}

export function validateComposition(
  composition: Composition,
  ctx: ValidateCompositionContext,
): CompositionValidation {
  const plan = planComposition(composition, ctx.lookupCap, ctx.target ?? undefined)
  const self = candidateSelf(composition, ctx, plan)
  const cycles = cycleProblems(composition, ctx, plan.fields, self)
  const problems = [...plan.problems, ...sourceProblems(plan.fields, ctx, self), ...cycles]
  return {
    ok: problems.length === 0,
    problems,
    fields: [...plan.fields],
    features: [...plan.features],
    events: [...plan.events],
  }
}
