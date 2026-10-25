/**
 * The runner boot check (D877).
 *
 * One-shot, ~60 s after the boot sequence: compare the runners this node
 * PLANNED with the states its process service reports, keep the answer in
 * memory and serve it on `serverManagement.getServerPackageStatus`
 * (`runners`). On 2026-10-17 nineteen runners stayed dead for four hours with
 * no durable signal, because the only announcement (an event) was consumed by
 * addons that were themselves among the dead.
 *
 * This is NOT a retry loop or a wait-for-registration timer (D3): it runs once,
 * answers once, and every later read is the stored answer. An operator
 * re-running it is `run()`.
 */
import type { IScopedLogger, RunnerBootCheck } from '@camstack/types'

/** The slice of a `$process.list` row the check reads. */
export interface RunnerStateRow {
  readonly name: string
  readonly addonIds: readonly string[]
  readonly state: string
  readonly refusal?: { readonly reason: string }
}

export interface EvaluateRunnerBootCheckInput {
  /** The hub's plan (`resolveRunnerId` over its forked addons); `null` where only the hub plans (an agent). */
  readonly planned: readonly string[] | null
  readonly processes: readonly RunnerStateRow[]
  readonly now: number
}

/**
 * Pure verdict. A planned runner is `running`, `refused` (typed Init refusal),
 * `missing` (the process service has no entry), or `failed` - which here means
 * "has an entry and is none of the above": the D6 breaker's terminal state, a
 * crash waiting on its backoff, a stop, or a start that never reached READY.
 */
export function evaluateRunnerBootCheck(input: EvaluateRunnerBootCheckInput): RunnerBootCheck {
  const byName = new Map(input.processes.map((p) => [p.name, p]))
  const expectedIds = input.planned ?? input.processes.map((p) => p.name)
  const failed: string[] = []
  const refused: RunnerBootCheck['refused'] = []
  const missing: string[] = []
  const pending: string[] = []
  let running = 0
  for (const runnerId of expectedIds) {
    const row = byName.get(runnerId)
    if (row === undefined) {
      missing.push(runnerId)
    } else if (row.state === 'running') {
      running += 1
    } else if (row.state === 'starting' || row.state === 'crashed') {
      // On its way: a slow boot or a crash waiting on its backoff respawn is not
      // a failure yet - the breaker (`failed`) is what says "gave up".
      pending.push(runnerId)
    } else if (row.state === 'refused') {
      refused.push({
        runnerId,
        addonIds: [...row.addonIds],
        reason: row.refusal?.reason ?? 'refused to start (reason not reported)',
      })
    } else {
      failed.push(runnerId)
    }
  }
  return {
    checkedAtMs: input.now,
    expected: expectedIds.length,
    running,
    failed,
    refused,
    missing,
    pending,
    planKnown: input.planned !== null,
  }
}

/** True when no runner is still on its way - only a settled verdict is pushed. */
export function isRunnerBootCheckSettled(check: RunnerBootCheck): boolean {
  return (check.pending ?? []).length === 0
}

/** True when the check found anything an operator has to act on. */
export function isRunnerBootCheckDegraded(check: RunnerBootCheck | undefined): boolean {
  return (
    check !== undefined &&
    (check.failed.length > 0 || check.refused.length > 0 || check.missing.length > 0)
  )
}

/** One sentence naming the findings, for a log line or an alert. */
export function describeRunnerBootCheck(check: RunnerBootCheck): string {
  const parts: string[] = []
  if (check.failed.length > 0) parts.push(`failed: ${check.failed.join(', ')}`)
  if (check.refused.length > 0) {
    parts.push(`refused: ${check.refused.map((r) => `${r.runnerId} (${r.reason})`).join('; ')}`)
  }
  if (check.missing.length > 0) parts.push(`missing: ${check.missing.join(', ')}`)
  if ((check.pending ?? []).length > 0)
    parts.push(`still starting: ${(check.pending ?? []).join(', ')}`)
  return `${check.running}/${check.expected} runners running${parts.length > 0 ? ` - ${parts.join(' - ')}` : ''}`
}

export const RUNNER_BOOT_CHECK_DELAY_MS = 60_000

export interface RunnerBootCheckServiceOptions {
  readonly logger: IScopedLogger
  readonly nodeId: string
  readonly planned: () => readonly string[] | null
  readonly listProcesses: () => Promise<readonly RunnerStateRow[]>
  /** Called with every verdict (alerts, notifications). Never throws into the check. */
  readonly onResult?: (check: RunnerBootCheck) => void
  readonly now?: () => number
}

export class RunnerBootCheckService {
  private latest: RunnerBootCheck | undefined
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly options: RunnerBootCheckServiceOptions) {}

  /** The stored verdict; `undefined` until the check has run. */
  current(): RunnerBootCheck | undefined {
    return this.latest
  }

  /** Arm the one-shot check. A second call while armed is a no-op. */
  scheduleAfterBoot(delayMs: number = RUNNER_BOOT_CHECK_DELAY_MS): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, delayMs)
    this.timer.unref()
  }

  private reevaluating: Promise<unknown> | null = null

  /**
   * A runner settled on a state. While the stored verdict still has pending
   * runners, evaluate again - once at a time, no timer: the process service
   * tells us when something changed (D3).
   */
  noteRunnerChange(): void {
    if (this.latest === undefined || isRunnerBootCheckSettled(this.latest)) return
    if (this.reevaluating !== null) {
      // A change landed while a re-evaluation was reading: read once more after it.
      this.changedDuringRun = true
      return
    }
    this.reevaluating = this.run().finally(() => {
      this.reevaluating = null
      if (this.changedDuringRun) {
        this.changedDuringRun = false
        this.noteRunnerChange()
      }
    })
  }

  private changedDuringRun = false

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Run the check now. A process service that cannot answer leaves the previous verdict. */
  async run(): Promise<RunnerBootCheck | undefined> {
    const { logger, nodeId } = this.options
    let processes: readonly RunnerStateRow[]
    try {
      processes = await this.options.listProcesses()
    } catch (err) {
      logger.warn('runner boot check could not list the runners - no verdict recorded', {
        tags: { nodeId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return this.latest
    }
    const check = evaluateRunnerBootCheck({
      planned: this.options.planned(),
      processes,
      now: (this.options.now ?? Date.now)(),
    })
    this.latest = check
    const summary = describeRunnerBootCheck(check)
    if (!isRunnerBootCheckSettled(check)) {
      // Not final: nothing is announced until every runner has settled; the next
      // runner state change re-evaluates (`noteRunnerChange`).
      logger.info(`runner boot check not settled: ${summary}`, { tags: { nodeId } })
      return check
    }
    if (isRunnerBootCheckDegraded(check)) {
      logger.error(`runner boot check DEGRADED: ${summary}`, { tags: { nodeId } })
    } else {
      logger.info(`runner boot check: ${summary}`, { tags: { nodeId } })
    }
    try {
      this.options.onResult?.(check)
    } catch (err) {
      logger.warn('runner boot check result handler threw', {
        tags: { nodeId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    return check
  }
}
