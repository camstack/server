import type { ProcessGroupOps } from '../../moleculer/runner-process-group.js'

/**
 * Process-group operations for suites that spawn FAKE runners. Their pids (70001,
 * 80001, …) are invented, and a real `kill(-70001)` on the machine running the suite
 * would signal whatever group happens to own that id. Every group reads as already
 * empty (ESRCH), so the reap completes at once and signals nothing.
 */
export const inertProcessGroups: ProcessGroupOps = {
  kill: () => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  },
  listMembers: () => Promise.resolve([]),
  sleep: () => Promise.resolve(),
  graceMs: 0,
}
