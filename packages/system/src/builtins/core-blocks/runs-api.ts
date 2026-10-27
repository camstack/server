/**
 * The three `core-blocks` methods that front the runs ledger.
 *
 * A block writes ONLY its own row: the transport stamps `callerAddonId` on every
 * `core-blocks` call (it is in `CALLER_STAMPED_CAPABILITIES`), and anything but
 * `core-block-<blockId>` is refused — and logged, because a refusal nobody sees
 * reads as a trace that never happened. The operator reads through `getTraces`,
 * which is admin-tier and takes no stamp.
 */
import {
  type AutomationRunTrace,
  type AutomationStateDoc,
  coreBlockAddonId,
  type IScopedLogger,
} from '@camstack/types'
import { automationOwner, type RunsLedger } from './runs-ledger.js'

export interface ReportAutomationRunInput {
  readonly blockId: string
  readonly trace?: AutomationRunTrace
  readonly runStartedAt?: number
  readonly keepTraces?: number
}

export interface RunsApi {
  reportAutomationRun(input: ReportAutomationRunInput): Promise<void>
  getAutomationRunState(input: { readonly blockId: string }): Promise<AutomationStateDoc>
  getTraces(input: {
    readonly blockId: string
  }): Promise<{ traces: AutomationRunTrace[]; lastError: string | null }>
}

/** The transport's stamp on a call, or null when the call carries none. */
function stampOf(input: object): string | null {
  const raw: unknown = Reflect.get(input, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

export function buildRunsApi(ledger: RunsLedger, logger: IScopedLogger): RunsApi {
  function requireOwner(input: { readonly blockId: string }, what: string): void {
    const stamp = stampOf(input)
    if (stamp === coreBlockAddonId(input.blockId)) return
    logger.warn(`${what} refused — only the block itself may touch its own run state`, {
      meta: { blockId: input.blockId, caller: stamp ?? 'unstamped' },
    })
    throw new Error(
      `core-blocks: ${what} for "${input.blockId}" refused — caller ${stamp ?? '(unstamped)'} is not that block`,
    )
  }

  return {
    async reportAutomationRun(input) {
      requireOwner(input, 'reportAutomationRun')
      if (input.trace === undefined && input.runStartedAt === undefined) {
        logger.warn('reportAutomationRun ignored — it carried neither a trace nor a stamp', {
          meta: { blockId: input.blockId },
        })
        throw new Error('core-blocks: reportAutomationRun needs a trace or a runStartedAt')
      }
      await ledger.report(automationOwner(input.blockId), {
        ...(input.trace === undefined ? {} : { trace: input.trace }),
        ...(input.runStartedAt === undefined ? {} : { runStartedAt: input.runStartedAt }),
        ...(input.keepTraces === undefined ? {} : { keepTraces: input.keepTraces }),
      })
    },

    async getAutomationRunState(input) {
      requireOwner(input, 'getAutomationRunState')
      const view = await ledger.get(automationOwner(input.blockId))
      return { version: 1, lastRunStartedAt: view.lastRunStartedAt, traces: [...view.traces] }
    },

    async getTraces(input) {
      const view = await ledger.get(automationOwner(input.blockId))
      return { traces: [...view.traces], lastError: view.lastError }
    },
  }
}
