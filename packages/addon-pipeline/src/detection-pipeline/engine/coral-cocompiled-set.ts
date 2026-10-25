/**
 * Which co-compiled set a Coral pool loads, decided from the models PLACED on
 * it (D724). Pure: no fs, no pool, no logger — the factory owns the state and
 * the provider the logging.
 *
 * "Placed" is what the pool has been asked to run: the union, over the
 * dispatches this pool has served, of every enabled step in the dispatch. A
 * Coral-elected camera's first dispatch carries the root and every subtree
 * that stays on the Coral (`stepsForElectedPool`), so the placement is known
 * before the first model loads; a step jumped onto the Coral from another
 * device (`jumpDeviceKey`) joins when its first dispatch arrives. The union
 * only grows — it is reset by the pool's own lifetime (idle eviction, a
 * respawn), never by a dispatch that happens not to carry a step.
 */
import type { ModelCatalogEntry, PipelineDefaultStep } from '@camstack/types'
import { flattenEnabledVideoSteps } from './step-utils.js'
import type { CoCompiledSet, CoCompiledSetMember } from '../registry/edgetpu-cocompiled-sets.js'

export const ROOT_DETECTOR_STEP_ID = 'object-detection'

export interface PlacedModel {
  readonly stepId: string
  readonly modelId: string
}

export type CoralSetSelection =
  | {
      readonly kind: 'set'
      readonly set: CoCompiledSet
      /** Placed models that load from the set's files. */
      readonly covered: readonly PlacedModel[]
      /** Placed models no member stands for: they load separately and swap against the set. */
      readonly uncovered: readonly PlacedModel[]
    }
  | {
      readonly kind: 'separate'
      /** `single-model`: one placed model has the cache to itself — no set can do better. */
      readonly reason: 'nothing-placed' | 'single-model' | 'no-set-covers-two'
    }

/** The models a dispatch places on the pool that runs it: every enabled video step. */
export function placedModelsOf(steps: readonly PipelineDefaultStep[]): readonly PlacedModel[] {
  return flattenEnabledVideoSteps(steps).map((s) => ({ stepId: s.addonId, modelId: s.modelId }))
}

const sameModel = (a: PlacedModel, b: PlacedModel): boolean =>
  a.stepId === b.stepId && a.modelId === b.modelId

/**
 * The set for `placed`, or why there is none.
 *
 * 1. A set that reserves the cache for the root detector is eligible only when
 *    the root is placed here, and a rootless set only when it is not: a root
 *    set on a pool without the root wastes the cache the root would have had,
 *    and a rootless set beside a root makes the root swap.
 * 2. A set must stand for at least two placed models — one model alone is
 *    better off with the whole cache (its separately compiled file).
 * 3. Most placed models covered wins; then the set with fewest members nobody
 *    placed (they hold cache for nothing); then declaration order.
 */
export function selectCoCompiledSet(
  placed: readonly PlacedModel[],
  sets: readonly CoCompiledSet[],
): CoralSetSelection {
  if (placed.length === 0) return { kind: 'separate', reason: 'nothing-placed' }
  if (placed.length === 1) return { kind: 'separate', reason: 'single-model' }
  const hostsRoot = placed.some((p) => p.stepId === ROOT_DETECTOR_STEP_ID)
  let best: { set: CoCompiledSet; covered: PlacedModel[]; idle: number } | null = null
  for (const set of sets) {
    if (set.hostsRoot !== hostsRoot) continue
    const covered = placed.filter((p) => set.members.some((m) => sameModel(m, p)))
    if (covered.length < 2) continue
    const idle = set.members.length - covered.length
    if (
      best === null ||
      covered.length > best.covered.length ||
      (covered.length === best.covered.length && idle < best.idle)
    ) {
      best = { set, covered, idle }
    }
  }
  if (best === null) return { kind: 'separate', reason: 'no-set-covers-two' }
  const { set, covered } = best
  return {
    kind: 'set',
    set,
    covered,
    uncovered: placed.filter((p) => !covered.some((c) => sameModel(c, p))),
  }
}

/** The member a selection loads `(stepId, modelId)` from, or `null` (its own `formats.tflite`). */
export function setMemberFor(
  selection: CoralSetSelection,
  stepId: string,
  modelId: string,
): CoCompiledSetMember | null {
  if (selection.kind !== 'set') return null
  return selection.set.members.find((m) => m.stepId === stepId && m.modelId === modelId) ?? null
}

/**
 * `entry` with its `tflite` build pointed at the set's file. Everything else —
 * labels, postprocessor, input contract, licence — is the entry's own: a
 * member is the same model, compiled together with others.
 */
export function withSetBuild(
  entry: ModelCatalogEntry,
  member: CoCompiledSetMember,
): ModelCatalogEntry {
  return {
    ...entry,
    formats: {
      ...entry.formats,
      tflite: { url: member.url, sizeMB: member.sizeMB, runtimes: ['python'] },
    },
  }
}

/** Identity of a selection for change detection: the set AND what it leaves out. */
const selectionKey = (s: CoralSetSelection): string =>
  s.kind === 'set'
    ? `${s.set.id}|${s.uncovered
        .map((u) => `${u.stepId}/${u.modelId}`)
        .toSorted()
        .join(',')}`
    : `separate:${s.reason}`

export type CoralPlacementChange =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'changed'
      readonly from: CoralSetSelection
      readonly to: CoralSetSelection
      readonly placed: readonly PlacedModel[]
    }

/**
 * The placement of ONE Coral pool and the set it loads. Lives exactly as long
 * as the pool (the factory owns it).
 */
export class CoralSetPlanner {
  private readonly placed: PlacedModel[] = []
  private current: CoralSetSelection = { kind: 'separate', reason: 'nothing-placed' }

  constructor(private readonly sets: readonly CoCompiledSet[]) {}

  /** Add the models a dispatch places on this pool; say whether the set changed. */
  note(models: readonly PlacedModel[]): CoralPlacementChange {
    let grew = false
    for (const m of models) {
      if (this.placed.some((p) => sameModel(p, m))) continue
      this.placed.push({ stepId: m.stepId, modelId: m.modelId })
      grew = true
    }
    if (!grew) return { kind: 'unchanged' }
    const next = selectCoCompiledSet(this.placed, this.sets)
    if (selectionKey(next) === selectionKey(this.current)) {
      this.current = next
      return { kind: 'unchanged' }
    }
    const from = this.current
    this.current = next
    return { kind: 'changed', from, to: next, placed: [...this.placed] }
  }

  selection(): CoralSetSelection {
    return this.current
  }

  /** `entry` as this pool must load it: from the set when the set stands for it. */
  entryFor(stepId: string, entry: ModelCatalogEntry): ModelCatalogEntry {
    const member = setMemberFor(this.current, stepId, entry.id)
    return member === null ? entry : withSetBuild(entry, member)
  }
}
