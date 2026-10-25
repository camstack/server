/**
 * Boot-time §10 reconcile of all non-terminal lifecycle jobs.
 *
 * After a crash mid-job (an "Update all" bulk job, a single addon update, …)
 * the on-disk journal holds tasks parked in a non-terminal phase. This boot
 * entry re-drives every active job through the engine so each addon task
 * resumes from its checkpoint (reusing a still-valid `stagedPath` or
 * re-fetching, then applying).
 *
 * Best-effort: this NEVER throws — any error (runner not initialized, journal
 * corruption, …) is swallowed and reported as `{ resumed: 0, failed: 0 }` so the
 * post-boot path can never crash the hub.
 *
 * Framework tasks are no longer applied by the engine (single-copy collapse —
 * framework updates ship via `applyServerUpdate`); any stray non-terminal
 * framework task is marked `skipped` during reconcile so the job can finalize.
 */

import { getLifecycleRunner } from '../core/lifecycle/lifecycle-runner.singleton.js'

export async function reconcileLifecycleJobsAtBoot(): Promise<{
  resumed: number
  failed: number
}> {
  try {
    return await getLifecycleRunner().reconcile()
  } catch {
    // Never crash the post-boot path.
    return { resumed: 0, failed: 0 }
  }
}
