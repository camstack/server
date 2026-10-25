/**
 * When may the kernel DELETE a parent's accessory children? (D49, 2026-10-21)
 *
 * Deleting an accessory is destructive: its id, bindings and history go with
 * it, and a re-spawn gets a NEW id. Dreame without credentials answered
 * `getAccessoryChildren()` with only the core child and the kernel pruned 97
 * accessories. The contract:
 *
 * 1. A prune is only ever the result of a SUCCESSFUL read — the provider
 *    positively says "connected, and this is the complete list". Missing
 *    credentials, a disconnected parent, a failed or partial read, a boot
 *    before the first successful connect: all UNKNOWN, and unknown prunes
 *    nothing (nor does it confirm or cancel an earlier shrink).
 *    - `{ kind: 'complete', children }` is a successful read.
 *    - `{ kind: 'unknown', reason, known? }` is unknown; `known` children are
 *      still spawned (spawning is idempotent and destroys nothing).
 *    - a bare array (the legacy answer) is successful only while the parent
 *      reports itself `online` AND its feature probe has completed.
 * 2. A SHRINK needs a second agreeing successful read on a LATER probe
 *    (`feature-probe.lastProbedAt` advanced). The first read that lacks a
 *    child only records it; the child is pruned when a successful read of a
 *    later probe still lacks it. A successful read that lists it again
 *    forgets the record.
 */
import type { AccessoryChildrenAnswer, AccessoryChildSpec } from '@camstack/types'

export type AccessoryReadVerdict =
  | { readonly kind: 'successful'; readonly children: readonly AccessoryChildSpec[] }
  | {
      readonly kind: 'unknown'
      readonly reason: string
      /** What may still be SPAWNED (spawning is idempotent and never destroys). */
      readonly children: readonly AccessoryChildSpec[]
    }

export interface AccessoryReadContext {
  readonly online: boolean
  /** `feature-probe.lastProbedAt`; 0 = the probe never completed. */
  readonly probedAt: number
}

function isSpecList(answer: AccessoryChildrenAnswer): answer is readonly AccessoryChildSpec[] {
  return Array.isArray(answer)
}

export function classifyAccessoryRead(
  answer: AccessoryChildrenAnswer,
  ctx: AccessoryReadContext,
): AccessoryReadVerdict {
  if (isSpecList(answer)) {
    if (!ctx.online) return { kind: 'unknown', reason: 'parent offline', children: answer }
    if (ctx.probedAt === 0) {
      return { kind: 'unknown', reason: 'probe not yet completed', children: answer }
    }
    return { kind: 'successful', children: answer }
  }
  if (answer.kind === 'unknown') {
    return { kind: 'unknown', reason: answer.reason, children: answer.known ?? [] }
  }
  return { kind: 'successful', children: answer.children }
}

export interface ShrinkDecision {
  /** Confirmed by a successful read of a later probe: delete these. */
  readonly prune: readonly number[]
  /** Missing for the first time (or again on the same probe): kept, recorded. */
  readonly deferred: readonly number[]
}

/** One per parent registration; in-memory on purpose (a restart starts over — the safe direction). */
export class AccessoryShrinkGate {
  /** childId → the probe (`lastProbedAt`) of the first successful read that lacked it. */
  readonly #firstMissing = new Map<number, number>()

  /**
   * `missing` = the managed children a SUCCESSFUL read no longer lists. Never
   * call this for an unknown read.
   */
  decide(missing: readonly number[], probedAt: number): ShrinkDecision {
    const missingSet = new Set(missing)
    for (const id of [...this.#firstMissing.keys()]) {
      if (!missingSet.has(id)) this.#firstMissing.delete(id)
    }
    const prune: number[] = []
    const deferred: number[] = []
    for (const id of missing) {
      const first = this.#firstMissing.get(id)
      if (first !== undefined && probedAt > first) {
        prune.push(id)
        this.#firstMissing.delete(id)
        continue
      }
      if (first === undefined) this.#firstMissing.set(id, probedAt)
      deferred.push(id)
    }
    return { prune, deferred }
  }
}
