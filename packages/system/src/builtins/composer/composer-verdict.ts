/**
 * What a block's report says (D659, D663): one verdict per live block, every
 * one naming its reason. Pure over the live entry — split from `composer.ts`.
 *
 * - A new-target block whose device exists and runs no runtime plans no field:
 *   nothing to run is running (the pre-split verdict, M-6).
 * - A runtime built by an apply and not yet started by its sync is `starting`.
 * - A released field is `degraded` (S1b), naming the field and its source.
 * - An added cap no graft serves (refused, or taken by a native) is `degraded`
 *   naming it; every added cap unserved is `failed` (Task 10, I-1).
 * - A HELD field — unavailable, but no source has answered so (a failed, first
 *   or empty read) — keeps its last value and its claim: `starting`, naming
 *   the field and why (D49, fix round 2). Released wins: it is the harder fact.
 */
import type { ComposerBlockVerdict, CompositionFieldState } from '@camstack/types'

function isUnfilledProblemLine(line: string): boolean {
  return line.includes('is required and has no source')
}
import type { ComposedDeviceHandle } from './composed-device.js'
import type { PlannedBlock } from './composer-plan.js'
import type { CompositionRuntime } from './composition-runtime.js'
import type { GraftVerdict } from './composer-grafts.js'
import { degradedReason, heldReason } from './existing-target.js'

/** A runtime built by an apply, before the apply's sync decides whether it may start. */
export const NOT_STARTED = 'the runtime has not started yet'

export interface LiveComposition {
  readonly planned: PlannedBlock
  /** The composed device of a `new` target; null for an existing one. */
  readonly device: ComposedDeviceHandle | null
  readonly runtime: CompositionRuntime | null
  readonly appliedName: string | null
  /** Why the device could not be rebuilt for a new shape; the previous one is kept. */
  readonly rebuildError: string | null
  /** Rule 4: the last values of a customization that stopped planning, reported stale. */
  readonly heldFields: readonly CompositionFieldState[]
}

export function verdictOf(
  blockId: string,
  entry: LiveComposition | undefined,
  unsynced: boolean,
  grafts: GraftVerdict | null = null,
): ComposerBlockVerdict {
  if (entry === undefined) return { blockId, status: 'starting', reason: 'not applied yet' }
  if (entry.rebuildError !== null) {
    return {
      blockId,
      status: 'failed',
      reason: `rebuilding the composed device for its new shape failed: ${entry.rebuildError}`,
    }
  }
  if (entry.planned.problems.length > 0) {
    const onlyUnfilled = entry.planned.problems.every(isUnfilledProblemLine)
    if (onlyUnfilled) {
      return {
        blockId,
        status: 'incomplete',
        reason: `required fields still need a source: ${entry.planned.problems.join('; ')}`,
      }
    }
    const kept =
      entry.planned.declaration === null ? '' : ' — its device is kept offline with no capabilities'
    return {
      blockId,
      status: 'failed',
      reason: `the composition does not validate: ${entry.planned.problems.join('; ')}${kept}`,
    }
  }
  if (!entry.planned.block.enabled) return { blockId, status: 'stopped' }
  const target = entry.planned.target
  if (target.kind === 'existing') {
    if (target.gone !== null)
      return { blockId, status: 'failed', reason: `the target device is gone: ${target.gone}` }
    if (target.waiting !== null) return { blockId, status: 'starting', reason: target.waiting }
  } else if (entry.device === null) {
    return {
      blockId,
      status: 'starting',
      reason: 'the composed device has not been constructed yet',
    }
  }
  const runtime = entry.runtime
  // With no active feature there is deliberately no runtime: nothing to run is running.
  if (runtime === null) {
    if (target.kind !== 'existing' || target.features.length === 0)
      return { blockId, status: 'running' }
    return { blockId, status: 'starting', reason: NOT_STARTED }
  }
  if (unsynced) return { blockId, status: 'starting', reason: NOT_STARTED }
  const state = runtime.state()
  if (state.failure !== null) return { blockId, status: 'failed', reason: state.failure }
  // I-1: an added cap no graft serves is named — every one unserved, nothing the block adds works.
  if (grafts?.allUnserved === true) return { blockId, status: 'failed', reason: grafts.reason }
  const degraded = [
    ...(state.released.length > 0 ? [degradedReason(state.released)] : []),
    ...(grafts === null ? [] : [grafts.reason]),
  ]
  if (degraded.length > 0) return { blockId, status: 'degraded', reason: degraded.join('; ') }
  if (state.held.length > 0) return { blockId, status: 'starting', reason: heldReason(state.held) }
  return { blockId, status: 'running' }
}
