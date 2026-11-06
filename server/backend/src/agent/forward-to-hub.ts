import type { CapCallInput } from '@camstack/server/system'

/** The budget one agent -> hub cap call has, registration wait included. */
export const FORWARD_TO_HUB_TIMEOUT_MS = 60_000

export interface ForwardToHubDeps {
  /** Resolves once the hub holds the manifest as of now (`AgentHubRegistration.settled`). */
  readonly settled: () => Promise<void>
  /** The mesh call, given the envelope and the budget it has left. */
  readonly call: (envelope: Record<string, unknown>, timeoutMs: number) => Promise<unknown>
  readonly log: {
    warn: (message: string, extras: { tags: { addonId: string } }) => void
  }
  readonly timeoutMs?: number
}

/**
 * Agent -> hub forward of a child's cap call. A stamped call is believed by the hub only against
 * the manifest it holds for this node, so it goes after the registration in flight landed - but
 * never later than the call's own budget: with the hub unreachable the registration retries
 * forever, and the call must still fail at its deadline as it always did. On expiry the call
 * goes out anyway (the hub drops an unverified stamp) with only the remaining budget.
 */
export function createForwardToHub(
  deps: ForwardToHubDeps,
): (input: CapCallInput) => Promise<unknown> {
  const budget = deps.timeoutMs ?? FORWARD_TO_HUB_TIMEOUT_MS
  return async (input) => {
    const startedAt = Date.now()
    if (input.callerAddonId !== undefined) {
      const deadline = AbortSignal.timeout(budget)
      const expired = new Promise<'expired'>((resolve) =>
        deadline.addEventListener('abort', () => resolve('expired'), {
          once: true,
        }),
      )
      const outcome = await Promise.race([deps.settled().then(() => 'settled' as const), expired])
      if (outcome === 'expired') {
        deps.log.warn('a stamped cap call went out before the registration settled', {
          tags: { addonId: input.callerAddonId },
        })
      }
    }
    const remaining = Math.max(1, budget - (Date.now() - startedAt))
    return deps.call(
      {
        capName: input.capName,
        method: input.method,
        args: input.args,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        // The native-only hint must survive the forward: the agent has no native authority.
        ...(input.native === true ? { native: true } : {}),
        // WHO is calling: stamped by this agent's registry off the child connection (D787).
        ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
      },
      remaining,
    )
  }
}
