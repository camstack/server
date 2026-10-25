/**
 * Process-wide singleton holder for the lifecycle job runner.
 *
 * The runner used to be built per-tRPC-request inside the `addons` cap factory,
 * so there was no stable instance for boot-reconcile (F3 Task 4) or the
 * auto-update scheduler (F3 Task 5) to use. This module builds the runner ONCE
 * at boot (from the `AddonPackageService` + event bus, wired in `manual-boot`)
 * and exposes it to every consumer.
 */

import {
  createLifecycleJobRunner,
  type LifecycleJobRunner,
  type LifecycleJobRunnerDeps,
} from '../../api/core/lifecycle-job-runner.js'

let instance: LifecycleJobRunner | null = null

/**
 * Build the runner once. Idempotent: a second call returns the already-built
 * instance and ignores the new deps (it does NOT rebuild).
 */
export function initLifecycleRunner(deps: LifecycleJobRunnerDeps): LifecycleJobRunner {
  if (instance === null) {
    instance = createLifecycleJobRunner(deps)
  }
  return instance
}

/**
 * Return the process-wide runner. Throws if `initLifecycleRunner` has not been
 * called yet (boot wiring is expected to init it before any consumer runs).
 */
export function getLifecycleRunner(): LifecycleJobRunner {
  if (instance === null) {
    throw new Error(
      'lifecycle runner not initialized — call initLifecycleRunner(deps) at boot before use',
    )
  }
  return instance
}

/** Test-only: reset the singleton between specs. */
export function __resetLifecycleRunnerForTests(): void {
  instance = null
}
