/**
 * The two preconditions an apply waits on BEFORE it reads anything (D49, R2):
 * the `core_blocks` store has loaded, and the shared Blocks integration has
 * reconciled. Each wait is warned once per run — the supervisor re-applies
 * every converge while it waits — and its end is logged with the count of
 * applies it refused.
 */
import type { ComposerApplyInput, ComposerApplyResult, IScopedLogger } from '@camstack/types'

const INTEGRATION_WAIT = 'waiting for the shared Blocks integration to reconcile'
const STORE_NOT_LOADED =
  'the core_blocks store has not loaded — nothing is declared or withdrawn until it does'

/** An apply either waits, naming why, or goes on with the reconciled integration. */
export type ApplyGate =
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'go'; readonly integrationId: string }

export class ApplyWaits {
  /** Consecutive applies refused because `core_blocks` had not loaded: warned once per run. */
  private storeWaitApplies = 0
  /** Consecutive applies refused because the Blocks integration had not reconciled: warned once per run. */
  private integrationWaitApplies = 0

  constructor(private readonly logger: IScopedLogger) {}

  /** Whether this apply must act on nothing (and why), or may go on. */
  check(input: ComposerApplyInput, liveCount: number): ApplyGate {
    if (!input.storeLoaded) {
      // D49 (R2): a failed `core_blocks` read arrives here as ZERO blocks. A
      // fresh composer knows no device, so a gate could not protect them, and
      // `declare([])` would sweep every composed row. Nothing below runs; the
      // live runtimes, if any, keep going untouched. Warned once per run: the
      // supervisor re-applies every converge while it waits.
      this.storeWaitApplies += 1
      if (this.storeWaitApplies === 1) {
        this.logger.warn(
          'composer: the block store has not loaded — no device is declared, withdrawn or renamed',
          { meta: { blocks: input.blocks.length, live: liveCount } },
        )
      }
      return { kind: 'wait', reason: STORE_NOT_LOADED }
    }
    if (this.storeWaitApplies > 0) {
      this.logger.info('composer: the block store has loaded — applying again', {
        meta: { appliesRefused: this.storeWaitApplies },
      })
      this.storeWaitApplies = 0
    }
    if (input.integrationId === null) {
      this.integrationWaitApplies += 1
      if (this.integrationWaitApplies === 1) {
        this.logger.warn(
          'composer: the shared Blocks integration has not reconciled — no composed device can be declared',
          { meta: { blocks: input.blocks.length } },
        )
      }
      return { kind: 'wait', reason: INTEGRATION_WAIT }
    }
    if (this.integrationWaitApplies > 0) {
      this.logger.info('composer: the shared Blocks integration has reconciled — applying again', {
        meta: { appliesRefused: this.integrationWaitApplies },
      })
      this.integrationWaitApplies = 0
    }
    return { kind: 'go', integrationId: input.integrationId }
  }
}

/** Every block `starting`, naming the wait; nothing acted. */
export function waitingResult(blockIds: readonly string[], reason: string): ComposerApplyResult {
  return {
    blocks: blockIds.map((blockId) => ({ blockId, status: 'starting', reason })),
    acted: false,
  }
}
