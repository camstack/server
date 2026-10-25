/**
 * What `addons.list` reports as an addon's `process` (D877).
 *
 * Until D877 every initialized addon was reported `mode: 'in-process', state:
 * 'running', pid: <hub pid>` - a literal. 28 refused runners and 19 dead ones
 * showed as healthy on the Addons page. The truth lives in the process service
 * (`$process.list`): this module is the ONE place that turns a runner row (or
 * the absence of one) into the `process` field, and
 * `scripts/check-no-literal-addon-process-mode.ts` keeps the literal out of
 * everywhere else.
 */
import type { RunnerStateRow } from '../runner-health/runner-boot-check.js'

export type AddonProcessMode = 'forked' | 'in-process'

export interface AddonProcessView {
  readonly pid?: number
  readonly mode: AddonProcessMode
  readonly state: string
  /** The addon's own words, when the runner is `refused`. */
  readonly reason?: string
}

/** A live runner row as `$process.list` reports it. */
export interface RunnerProcessRow extends RunnerStateRow {
  readonly pid: number
}

export interface DescribeAddonProcessInput {
  /** Does this addon run in its own runner (`runsInOwnRunner`)? */
  readonly forked: boolean
  readonly initialized: boolean
  readonly runnerId: string
  /**
   * Runner rows by runner id; `null` when the process service has not been
   * asked, or could not answer. Unknown is `unknown`, never `running` (D393).
   */
  readonly runners: ReadonlyMap<string, RunnerProcessRow> | null
  /** The pid of hub-main, for addons that really run inside it. */
  readonly hubPid: number
}

export function describeAddonProcess(
  input: DescribeAddonProcessInput,
): AddonProcessView | undefined {
  if (!input.forked) {
    // Hosted by hub-main itself: its state is hub-main's, which is running if this code is.
    return input.initialized
      ? { pid: input.hubPid, mode: 'in-process', state: 'running' }
      : undefined
  }
  if (input.runners === null) return { mode: 'forked', state: 'unknown' }
  const row = input.runners.get(input.runnerId)
  if (row === undefined) return { mode: 'forked', state: 'missing' }
  return {
    pid: row.pid,
    mode: 'forked',
    state: row.state,
    ...(row.refusal !== undefined ? { reason: row.refusal.reason } : {}),
  }
}

/**
 * A package on disk that never loaded: there is no process, and the card must
 * show the diagnostic state distinctly (`scanFailedToLoadPackages`).
 */
export const NEVER_LOADED_PROCESS: AddonProcessView = { mode: 'in-process', state: 'failed' }
