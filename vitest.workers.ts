/**
 * The ONE vitest worker default, imported by every `vitest.config.ts`
 * (`maxWorkers: vitestMaxWorkers()`; guard: scripts/check-vitest-max-workers.ts).
 *
 * Without it vitest forks one worker per core (12 on the dev Mac) for EVERY
 * run, and parallel agents each starting a run swapped the machine to a stop
 * (22 workers, 12 of 13 GB swap). `VITEST_MAX_WORKERS` — which vitest also
 * reads itself — overrides it: the test slot sets 3 for agents
 * (scripts/ci/test-slot.sh), verify:push and CI set their own lane value.
 */
export const DEFAULT_VITEST_MAX_WORKERS = 3

export function vitestMaxWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.VITEST_MAX_WORKERS ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VITEST_MAX_WORKERS
}
