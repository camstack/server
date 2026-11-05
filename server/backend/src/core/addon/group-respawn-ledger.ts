/**
 * Which restart requests one group-runner fork may satisfy.
 *
 * The child loads whatever is on disk at the moment it is forked (D5: there
 * is no in-process reload). A request is satisfied only by a fork that starts
 * AFTER the request — the caller's swap is already on disk by then. A fork
 * already in flight does not count; that caller joins the single follow-up
 * which starts when the in-flight fork returns. No clock (D3).
 */

export interface GroupRespawnPids {
  readonly pidBefore: number | null
  readonly pidAfter: number | null
}

/** What `ensureForkedRunner` tells `restartAddon` about the process now up. */
export interface ForkedRunnerOutcome extends GroupRespawnPids {
  /** True when `pidAfter` is a process that forked after this request. */
  readonly live: boolean
}

interface GroupRespawnSlot {
  requested: number
  satisfied: number
  pidBefore: number | null
  pidAfter: number | null
}

export interface GroupRespawnLedger {
  /** Register a restart request. The epoch is 1-based and per runner. */
  claim(runnerId: string): number
  /** True when a fork that started after this epoch was claimed has finished. */
  covered(runnerId: string, epoch: number): boolean
  /**
   * How far a fork that is about to start may satisfy. Read synchronously
   * immediately before the fork, so a request that arrives during it is not
   * covered.
   */
  coverThrough(runnerId: string): number
  markForked(runnerId: string, coverThrough: number, pids: GroupRespawnPids): void
  pids(runnerId: string): GroupRespawnPids
}

export function forkedRunnerOutcome(
  pidBefore: number | null,
  pidAfter: number | null,
): ForkedRunnerOutcome {
  return {
    live: pidAfter !== null && pidAfter !== pidBefore,
    pidBefore,
    pidAfter,
  }
}

export function createGroupRespawnLedger(): GroupRespawnLedger {
  const slots = new Map<string, GroupRespawnSlot>()

  const slot = (runnerId: string): GroupRespawnSlot => {
    const existing = slots.get(runnerId)
    if (existing) return existing
    const created: GroupRespawnSlot = {
      requested: 0,
      satisfied: 0,
      pidBefore: null,
      pidAfter: null,
    }
    slots.set(runnerId, created)
    return created
  }

  return {
    claim(runnerId: string): number {
      const current = slot(runnerId)
      current.requested += 1
      return current.requested
    },
    covered(runnerId: string, epoch: number): boolean {
      return slot(runnerId).satisfied >= epoch
    },
    coverThrough(runnerId: string): number {
      return slot(runnerId).requested
    },
    markForked(runnerId: string, coverThrough: number, pids: GroupRespawnPids): void {
      const current = slot(runnerId)
      current.satisfied = Math.max(current.satisfied, coverThrough)
      current.pidBefore = pids.pidBefore
      current.pidAfter = pids.pidAfter
    },
    pids(runnerId: string): GroupRespawnPids {
      const current = slot(runnerId)
      return { pidBefore: current.pidBefore, pidAfter: current.pidAfter }
    },
  }
}
