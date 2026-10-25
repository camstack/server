/**
 * Keeps the node running for as long as the Windows service does.
 *
 * Why this exists: WinSW restarts a wrapped process only when it exits with an
 * ERROR. The node asks for its own restart by exiting 0 (a node/framework
 * update: `agent-update-service` self-terminates "for supervisor relaunch"), and
 * a service whose process exits 0 is simply stopped — the agent would go
 * offline after its first update. Docker's restart policy and the Electron
 * shell both relaunch on ANY exit; this is the same rule for the service.
 *
 * Pure over its dependencies so the loop is testable without processes or
 * time. The entry (`service-supervisor-main.ts`) wires the real ones.
 */

/** A child that has run this long is considered healthy: failures reset. */
export const HEALTHY_UPTIME_MS = 60_000
/** After a healthy run the relaunch is prompt (an update restart). */
export const RELAUNCH_DELAY_MS = 1_000
const BACKOFF_BASE_MS = 5_000
export const BACKOFF_MAX_MS = 5 * 60_000

export interface RelaunchDecision {
  readonly delayMs: number
  /** Consecutive quick failures, carried into the next decision. */
  readonly failures: number
}

/** How long to wait before the next launch, given how the last one went. */
export function decideRelaunch(previousFailures: number, uptimeMs: number): RelaunchDecision {
  if (uptimeMs >= HEALTHY_UPTIME_MS) return { delayMs: RELAUNCH_DELAY_MS, failures: 0 }
  const failures = previousFailures + 1
  return {
    delayMs: Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
    failures,
  }
}

export interface ChildHandle {
  /** Resolves when the child has exited, with how. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  kill(): void
}

export interface SupervisorDeps {
  spawnChild(): ChildHandle
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  log(line: string): void
}

export class NodeSupervisor {
  private readonly abort = new AbortController()
  private child: ChildHandle | null = null

  constructor(private readonly deps: SupervisorDeps) {}

  /** Ask the loop to end: kill the child and do not relaunch. */
  stop(): void {
    this.abort.abort()
    this.child?.kill()
  }

  async run(): Promise<void> {
    let failures = 0
    while (!this.abort.signal.aborted) {
      const startedAt = this.deps.now()
      this.child = this.deps.spawnChild()
      const result = await this.child.exited
      this.child = null
      if (this.abort.signal.aborted) break
      const decision = decideRelaunch(failures, this.deps.now() - startedAt)
      failures = decision.failures
      this.deps.log(
        `node exited (code=${result.code ?? 'null'}, signal=${result.signal ?? 'null'}) — relaunching in ${decision.delayMs} ms`,
      )
      await this.deps.sleep(decision.delayMs, this.abort.signal)
    }
  }
}
