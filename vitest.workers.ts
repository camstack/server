/**
 * The ONE vitest worker default, imported by every `vitest.config.ts`
 * (`...vitestWorkers()` under `test`; guard: scripts/check-vitest-max-workers.ts).
 *
 * Without it vitest forks one worker per core (12 on the dev Mac) for EVERY
 * run, and parallel agents each starting a run swapped the machine to a stop
 * (22 workers, 12 of 13 GB swap). `VITEST_MAX_WORKERS` — which vitest also
 * reads itself — overrides it: the test slot sets 3 for agents
 * (scripts/ci/test-slot.sh), verify:push and CI set their own lane value.
 *
 * The minimum travels with the maximum. Vitest 2 (still pinned by some addon
 * packages) defaults `minWorkers` to cores - 1 regardless of `maxWorkers`, and
 * tinypool then refuses to start ("options.minThreads and options.maxThreads
 * must not conflict"). Vitest 3 clamps it itself; vitest 4 has no minimum and
 * ignores the field.
 */
export const DEFAULT_VITEST_MAX_WORKERS = 3

/** The worker bounds every vitest config spreads into `test`. */
export interface VitestWorkerLimits {
  readonly maxWorkers: number
  readonly minWorkers: number
}

export function vitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.VITEST_MAX_WORKERS ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VITEST_MAX_WORKERS
}

export function vitestWorkers(env: NodeJS.ProcessEnv = process.env): VitestWorkerLimits {
  const maxWorkers = vitestMaxWorkers(env)
  return { maxWorkers, minWorkers: maxWorkers }
}
