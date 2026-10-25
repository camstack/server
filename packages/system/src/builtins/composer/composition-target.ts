/**
 * Where a composition writes, and the ports its runtime drives (D659, D663).
 * Split from `composition-runtime.ts`, which re-exports every name here.
 */
import type { ClaimOutcome, SystemEvent } from '@camstack/types'
import type { SlicePatch } from './slice-assembler.js'

export interface WriteOk {
  readonly ok: true
}
export interface WriteRefused {
  readonly ok: false
  readonly error: string
}
export type WriteOutcome = WriteOk | WriteRefused

/** Why an enqueued write did not land. `refused` carries the hub's code so the target can escalate by name (S5). */
export type TargetAsyncFailure =
  | { readonly kind: 'threw'; readonly error: string }
  | {
      readonly kind: 'refused'
      readonly code: Extract<ClaimOutcome, { ok: false }>['code']
      readonly message: string
    }

/**
 * Where a composition writes. A write answers `{ ok: false }` rather than
 * throwing, and `setAvailable` does not throw. The runtime survives either
 * anyway: a throwing write is a failed write, a throwing `setAvailable` is
 * retried on the next pass. A target whose writes are asynchronous reports
 * what did not land through `onAsyncFailure`.
 */
export interface ComposedWriteTarget {
  readonly id: number
  seed(capName: string, slice: SlicePatch): WriteOutcome
  patch(capName: string, patch: SlicePatch): WriteOutcome
  setAvailable(available: boolean): void
  onAsyncFailure?(listener: (cap: string, failure: TargetAsyncFailure) => void): void
  /**
   * S1b: these fields of `cap` are NOT the composition's to write right now
   * (their `release`-mode source is unavailable). The claim is narrowed to the
   * rest; an empty rest releases the whole cap. `[]` re-widens. Absent on a
   * `new`-target device (`ComposedDevice`): `release` is planned only on
   * existing targets.
   */
  withhold?(cap: string, fields: readonly string[]): WriteOutcome
  /**
   * Drop writes not yet sent and resolve once the one in flight has settled.
   * A stopped block calls this before its claims are released, so that claim
   * cannot land afterwards.
   */
  quiesce?(): Promise<void>
}

export interface DeadlineTimer {
  arm(at: number, fire: () => void): void
  disarm(): void
}

export interface CompositionEventEmitter {
  emit(event: SystemEvent): void
}
