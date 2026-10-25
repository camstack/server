/**
 * Which addons are "in error" on the Addons page, judged from the TRUTHFUL
 * `process` field of `addons.list` (D877) - the real state of the addon's
 * runner, never a literal.
 *
 *  - `failed`  the crash breaker gave up on the runner,
 *  - `refused` the addon said it will not start (the reason carries the remedy),
 *  - `missing` the addon is planned to fork and no runner exists,
 *  - `crashed` a crash waiting on its backoff respawn.
 *
 * `unknown` (the hub could not ask its process service) is NOT an error: not
 * knowing is not the same as broken.
 */
export type AddonProcessProblemKind = 'failed' | 'refused' | 'missing' | 'crashed'

export interface AddonProcessProblem {
  readonly kind: AddonProcessProblemKind
  /** The addon's own words, for a refusal. */
  readonly reason?: string
}

interface ProcessLike {
  readonly state: string
  readonly reason?: string
}

export function addonProcessProblem(process: ProcessLike | undefined): AddonProcessProblem | null {
  if (process === undefined) return null
  switch (process.state) {
    case 'failed':
    case 'refused':
    case 'missing':
    case 'crashed':
      return {
        kind: process.state,
        ...(process.reason !== undefined ? { reason: process.reason } : {}),
      }
    default:
      return null
  }
}
