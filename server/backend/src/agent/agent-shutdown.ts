/**
 * The agent's graceful shutdown, as a testable sequence.
 *
 * A SIGTERM once started a shutdown that awaited one addon's `shutdown()` for 9.5 minutes: the node
 * stayed alive but deregistered, and its desktop shell never noticed. So the pass is re-entry guarded
 * (a second signal forces the exit instead of starting a second pass), every step is bounded, the
 * whole pass has a hard deadline that ends in a non-zero `exit`, and every step logs its elapsed time
 * next to the reason the shutdown started.
 */
import type { IScopedLogger } from '@camstack/types'

export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000
export const SHUTDOWN_DEADLINE_MS = 15_000

export interface ShutdownStep {
  readonly name: string
  readonly run: () => Promise<void>
}

export interface AgentShutdownDeps {
  readonly steps: readonly ShutdownStep[]
  readonly logger: IScopedLogger
  readonly exit: (code: number) => void
  readonly stepTimeoutMs?: number
  readonly deadlineMs?: number
}

type StepOutcome = 'done' | 'timed-out'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runBounded(step: ShutdownStep, timeoutMs: number): Promise<StepOutcome> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<StepOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs)
  })
  try {
    return await Promise.race([step.run().then((): StepOutcome => 'done'), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Returns `shutdown(reason)`; `reason` names the signal or caller that started it. */
export function createAgentShutdown(deps: AgentShutdownDeps): (reason: string) => Promise<void> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS
  const { logger } = deps
  let startedAt: number | null = null

  return async (reason: string): Promise<void> => {
    if (startedAt !== null) {
      logger.error(
        `shutdown already in progress for ${Date.now() - startedAt}ms; ${reason} forces exit`,
      )
      deps.exit(1)
      return
    }
    const began = Date.now()
    startedAt = began
    logger.info(`shutdown started by ${reason}`)
    const deadline = setTimeout(() => {
      logger.error(
        `shutdown deadline of ${deadlineMs}ms exceeded (started by ${reason}); exiting 1`,
      )
      deps.exit(1)
    }, deadlineMs)

    for (const step of deps.steps) {
      const stepStart = Date.now()
      try {
        const outcome = await runBounded(step, stepTimeoutMs)
        const took = `${Date.now() - stepStart}ms`
        if (outcome === 'timed-out') {
          logger.warn(`shutdown step ${step.name} timed out after ${took}; continuing`)
        } else {
          logger.info(`shutdown step ${step.name} done in ${took}`)
        }
      } catch (err) {
        logger.warn(
          `shutdown step ${step.name} failed after ${Date.now() - stepStart}ms: ${errMessage(err)}`,
        )
      }
    }
    clearTimeout(deadline)
    logger.info(`shutdown finished in ${Date.now() - began}ms (started by ${reason})`)
    deps.exit(0)
  }
}
