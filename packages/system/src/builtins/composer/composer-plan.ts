/**
 * What one apply PLANS for a block, before anything is declared, claimed or
 * run (D659, D663). Pure over its inputs: the composer hands in what it knows
 * (its rows, the previous plan, the tracker) and gets a `PlannedBlock` back.
 *
 * - A `new` target plans as in slice 1: a declaration, a shape, a placeholder
 *   when the composition stopped planning but its row exists.
 * - An `existing` target declares NOTHING (the row is not the composer's). It
 *   is resolved through the tracker's path, described with one bindings read
 *   per plan change, and planned against that description. A settled plan is
 *   kept until the OPERATOR acts (edit, restart): a bindings change alone never
 *   re-plans (Task 10 rule 2, D659). While the claims index is unseeded or the
 *   target is unresolved or undescribed, the block WAITS by name and claims
 *   nothing (D49). A target gone on two agreeing index reads is `gone`.
 * - An unreadable row names no target: whatever it holds is held (D49).
 */
import {
  type CapabilityDefinition,
  type CapabilityLookup,
  type ComposerBlock,
  type ComposerUnreadableBlock,
  type CompositionExistingTarget,
  type CompositionEventPlan,
  type CompositionFeaturePlan,
  type CompositionFieldPlan,
  type CompositionNewTarget,
  type CompositionSourceRef,
  composedDeviceStableId,
  compositionFeatureEnabled,
  compositionSourceKey,
  type DeviceDeclaration,
  type DeviceType,
  type IScopedLogger,
  type LogTags,
  planComposition,
} from '@camstack/types'
import { declarationFor, placeholderDeclaration, shapeOf } from './composition-declarations.js'
import type { TargetDescriptions } from './existing-target.js'
import type { SourceResolution } from './source-tracker.js'

/** What the apply knows of a block besides its plan. `name` is null for an unreadable row whose name is unreadable too. */
export interface PlannedBlockMeta {
  readonly id: string
  readonly name: string | null
  readonly enabled: boolean
  readonly updatedAt: number
}

export interface ComposerDerivedSpec {
  readonly type: DeviceType
  readonly role?: string
}

export interface PlannedNewTarget {
  readonly kind: 'new'
}
/** A row that does not parse names no target: its claims, if any, are held (D49). */
export interface PlannedUnreadableTarget {
  readonly kind: 'unreadable'
}
export interface PlannedExistingTarget {
  readonly kind: 'existing'
  readonly ref: CompositionSourceRef
  /** The target row's id once resolved; null until then. */
  readonly deviceId: number | null
  /** Why the block is `starting` rather than planned: claims unseeded, target unresolved or undescribed. Nothing is claimed. */
  readonly waiting: string | null
  /** The target row is gone — two index reads agreed (rule 5). Sticky until an operator edit or restart. */
  readonly gone: string | null
  readonly features: readonly CompositionFeaturePlan[]
  /** The description the plan used: cap → the addon serving it; empty until described. */
  readonly nativeCaps: ReadonlyMap<string, string>
}
export type PlannedTarget = PlannedNewTarget | PlannedUnreadableTarget | PlannedExistingTarget

export interface PlannedBlock {
  readonly block: PlannedBlockMeta
  readonly fields: readonly CompositionFieldPlan[]
  readonly events: readonly CompositionEventPlan[]
  readonly problems: readonly string[]
  readonly declaration: DeviceDeclaration | null
  /** What forces a rebuild of the live device; null when nothing is declared. */
  readonly shape: string | null
  readonly spec: ComposerDerivedSpec | null
  readonly target: PlannedTarget
}

/** The shape of a placeholder: no caps, so no plan to take a shape from. */
const PLACEHOLDER_SHAPE = 'placeholder'

const NO_PLAN = {
  fields: [],
  events: [],
  problems: [],
  declaration: null,
  shape: null,
  spec: null,
} as const satisfies Omit<PlannedBlock, 'block' | 'target'>

/**
 * A row that exists but does not parse is held exactly like a composition
 * that stopped planning: its device (if it has a row) stays as an offline
 * placeholder, its claims (if any) are kept, and the block fails naming the
 * parse error. Absent, it would be withdrawn on the second apply that omitted
 * it (D49).
 */
export function planUnreadable(
  block: ComposerUnreadableBlock,
  rows: ReadonlySet<string>,
): PlannedBlock {
  const stableId = composedDeviceStableId(block.id)
  const hasRow = rows.has(stableId)
  return {
    ...NO_PLAN,
    block: { id: block.id, name: block.name, enabled: false, updatedAt: 0 },
    problems: [`the stored block does not parse — ${block.error}`],
    declaration: hasRow ? placeholderDeclaration(stableId) : null,
    shape: hasRow ? PLACEHOLDER_SHAPE : null,
    target: { kind: 'unreadable' },
  }
}

/** `target` is the block's own `new` target, narrowed by the caller: this path never sees an existing one (M-5). */
export function planNew(
  block: ComposerBlock,
  target: CompositionNewTarget,
  lookupCap: CapabilityLookup,
  rows: ReadonlySet<string>,
): PlannedBlock {
  const plan = planComposition(block.composition, lookupCap)
  const planned: PlannedNewTarget = { kind: 'new' }
  if (plan.problems.length > 0) {
    // A composition that stopped planning (a cap renamed by a release) must
    // not lose its device: the row is held by a placeholder — kept, offline,
    // no caps — and never runs a runtime. With no row there is nothing to keep.
    const stableId = composedDeviceStableId(block.id)
    const hasRow = rows.has(stableId)
    return {
      ...NO_PLAN,
      block,
      problems: plan.problems.map((p) => `${p.path}: ${p.message}`),
      declaration: hasRow ? placeholderDeclaration(stableId) : null,
      shape: hasRow ? PLACEHOLDER_SHAPE : null,
      target: planned,
    }
  }
  const caps = block.composition.features.flatMap((f): readonly CapabilityDefinition[] => {
    if (!compositionFeatureEnabled(f)) return []
    const def = lookupCap(f.cap)
    return def === null ? [] : [def]
  })
  const declarationInput = { blockId: block.id, name: block.name, target, caps }
  return {
    block,
    fields: plan.fields,
    events: plan.events,
    problems: [],
    declaration: declarationFor(declarationInput),
    shape: shapeOf(declarationInput),
    spec: { type: target.type, ...(target.role === undefined ? {} : { role: target.role }) },
    target: planned,
  }
}

/** The tracker's resolution path, as `planExisting` needs it (rule 1). */
export interface TargetResolver {
  resolve(ref: CompositionSourceRef, reset: boolean): Promise<SourceResolution>
}

export interface ExistingPlanInput {
  readonly block: ComposerBlock
  readonly target: CompositionExistingTarget
  /** The block's previous plan, if it is live. */
  readonly previous: PlannedBlock | undefined
  /** An edit, a restart, or the block's first appearance: the only things that re-plan a settled block. */
  readonly operatorAction: boolean
  /** Why the claims index is not seeded yet, else null. */
  readonly claimsWait: string | null
  readonly tracker: TargetResolver
  readonly targets: TargetDescriptions
  readonly lookupCap: CapabilityLookup
}

export async function planExisting(input: ExistingPlanInput): Promise<PlannedBlock> {
  const { block, previous, operatorAction } = input
  const prior = previous?.target
  if (
    !operatorAction &&
    previous !== undefined &&
    prior?.kind === 'existing' &&
    prior.waiting === null
  )
    return { ...previous, block }
  const ref = input.target.device
  const key = compositionSourceKey(ref)
  const knownId = prior?.kind === 'existing' ? prior.deviceId : null
  if (input.claimsWait !== null) return waitingPlan(block, ref, knownId, input.claimsWait)
  const resolution = await input.tracker.resolve(ref, operatorAction)
  if (resolution.kind === 'unknown') {
    return waitingPlan(
      block,
      ref,
      knownId,
      `the target device \`${key}\` could not be resolved (${resolution.error}) — nothing is claimed until it is; retried on the next apply`,
    )
  }
  const existing: PlannedExistingTarget = {
    kind: 'existing',
    ref,
    deviceId: resolution.kind === 'found' ? resolution.deviceId : knownId,
    waiting: null,
    gone: null,
    features: [],
    nativeCaps: new Map(),
  }
  if (resolution.kind === 'missing') {
    return {
      ...NO_PLAN,
      block,
      target: { ...existing, gone: `${resolution.reason} — two index reads agreed` },
    }
  }
  const description = await input.targets.describe(
    ref,
    resolution.deviceId,
    resolution.type,
    operatorAction,
  )
  if (description === null) {
    return waitingPlan(
      block,
      ref,
      resolution.deviceId,
      `the target device \`${key}\` could not be described (its bindings did not read) — nothing is claimed until it is; retried on the next apply`,
    )
  }
  const plan = planComposition(block.composition, input.lookupCap, description)
  return {
    ...NO_PLAN,
    block,
    fields: plan.problems.length > 0 ? [] : plan.fields,
    events: plan.problems.length > 0 ? [] : plan.events,
    problems: plan.problems.map((p) => `${p.path}: ${p.message}`),
    target: { ...existing, features: plan.features, nativeCaps: description.nativeCaps },
  }
}

function waitingPlan(
  block: ComposerBlock,
  ref: CompositionSourceRef,
  deviceId: number | null,
  waiting: string,
): PlannedBlock {
  return {
    ...NO_PLAN,
    block,
    target: {
      kind: 'existing',
      ref,
      deviceId,
      waiting,
      gone: null,
      features: [],
      nativeCaps: new Map(),
    },
  }
}

/**
 * Runtime preparation can still fail after a complete existing-target plan.
 * Preserve its fields and description for retry, but mark it waiting so claim
 * reconciliation cannot treat the unprepared candidate as live.
 */
export function withExistingTargetWait(p: PlannedBlock, waiting: string): PlannedBlock {
  return p.target.kind === 'existing' ? { ...p, target: { ...p.target, waiting } } : p
}

/** What `logPlanTransition` compares: problems, and for an existing target its wait or its loss. */
function planSummary(p: PlannedBlock): string {
  const target = p.target
  const parts =
    target.kind === 'existing'
      ? [p.problems.join('; '), target.waiting ?? '', target.gone ?? '']
      : [p.problems.join('; ')]
  return parts.filter((part) => part !== '').join(' | ')
}

/** A target the previous plan held live on `deviceId`, that this plan finds gone. */
export interface LostTarget {
  readonly target: PlannedExistingTarget
  readonly deviceId: number
}

/**
 * Rule 5 on the PLAN path: `device.unregistered` is telemetry and may be
 * dropped (D8), so a target is often found gone by the operator's next edit or
 * restart. The previous live target is what must be ungrafted — exactly as on
 * the event path. Null when nothing was lost by THIS plan.
 */
export function lostTarget(p: PlannedBlock, previous: PlannedBlock | undefined): LostTarget | null {
  const now = p.target
  const before = previous?.target
  if (now.kind !== 'existing' || now.gone === null || before?.kind !== 'existing') return null
  if (before.deviceId === null || before.gone !== null) return null
  return { target: before, deviceId: before.deviceId }
}

/** Two plans write the same place: both new, or the very same existing-target plan (reused until the operator acts). */
export function sameTarget(a: PlannedTarget, b: PlannedTarget): boolean {
  return a === b || (a.kind === 'new' && b.kind === 'new')
}

/** One line when a block starts or stops planning (or waiting, or loses its target) — never one per apply. */
export function logPlanTransition(
  logger: IScopedLogger,
  previous: PlannedBlock | undefined,
  p: PlannedBlock,
  liveTags: LogTags,
): void {
  if (previous !== undefined && planSummary(previous) === planSummary(p)) return
  if (previous === undefined && planSummary(p) === '') return
  const target = p.target
  const extras = {
    // The block is not live yet on its first apply: the plan itself knows the target's id.
    tags:
      target.kind === 'existing' && target.deviceId !== null
        ? { deviceId: target.deviceId }
        : liveTags,
    meta: { blockId: p.block.id, problems: p.problems, placeholder: p.declaration !== null },
  }
  if (target.kind === 'existing' && target.gone !== null) {
    logger.error(
      'customization target device is gone — the block failed; only the operator ends this (edit or restart the block)',
      { ...extras, meta: { ...extras.meta, target: compositionSourceKey(target.ref) } },
    )
  } else if (target.kind === 'existing' && target.waiting !== null) {
    logger.warn('customization waits — nothing is claimed or released until it plans', {
      ...extras,
      meta: { ...extras.meta, reason: target.waiting },
    })
  } else if (p.problems.length === 0) logger.info('composition plans again', extras)
  else
    logger.warn(
      p.declaration === null
        ? 'composition does not plan — no device is declared for it'
        : 'composition no longer plans — its device is kept offline with no capabilities',
      extras,
    )
}
