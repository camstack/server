/**
 * The hub's recovery of an agent whose mesh leaf expired (#558, amends D857).
 *
 * The transporter admits a peer whose only failure is the clock and announces it here. The node is
 * not usable yet - its capabilities are not registered - so the renewal waits for that registration
 * (the hub's registration completion, D3, not a poll) and then runs the SAME handover the operator's
 * `certificates.renewMeshOnNode` runs (`renewMeshCertificate`), which issues the no-expiry leaf. One
 * renewal per node at a time; a node that never registers is reported, not retried (its next
 * handshake announces it again).
 */
import type {
  ExpiredLeafAdmission,
  MeshLog,
  MeshRegistrations,
  RenewMeshResult,
} from '@camstack/server/system'

const DEFAULT_REGISTRATION_TIMEOUT_MS = 120_000

export interface ExpiredLeafRenewerDeps {
  readonly log: MeshLog
  /** The registration completions the renewal waits for. */
  readonly registrations: MeshRegistrations
  /**
   * Whether the node has already finished registering. The hub keeps a node's registration across
   * a reconnect, so an expired leaf admitted for a known node has no registration to wait for.
   */
  readonly isRegistered?: (nodeId: string) => boolean
  /** Run the renewal handover for `nodeId`; `null` when the node, the CA or the registry is not there. */
  readonly renew: (nodeId: string) => Promise<RenewMeshResult | null>
  readonly registrationTimeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export function createExpiredLeafRenewer(
  deps: ExpiredLeafRenewerDeps,
): (peer: ExpiredLeafAdmission) => void {
  const setTimer = deps.setTimer ?? defaultSetTimer
  const timeoutMs = deps.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS
  const pending = new Set<string>()

  const run = async (nodeId: string): Promise<void> => {
    const tags = { nodeId }
    try {
      const result = await deps.renew(nodeId)
      if (result === null) {
        deps.log.warn(
          'Expired mesh leaf not renewed: the node, the CA or the registry is not available',
          { tags },
        )
      } else if (result.ok) {
        deps.log.info('Expired mesh leaf replaced by a leaf with no expiry', {
          tags,
          meta: { newSerial: result.newSerial },
        })
      } else {
        deps.log.warn('Expired mesh leaf could not be renewed', {
          tags,
          meta: { stage: result.stage, reason: result.reason },
        })
      }
    } catch (error: unknown) {
      deps.log.error('Expired mesh leaf renewal threw', {
        tags,
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  return (peer) => {
    const { nodeId } = peer
    if (pending.has(nodeId)) return
    pending.add(nodeId)
    if (deps.isRegistered?.(nodeId) === true) {
      void run(nodeId).finally(() => pending.delete(nodeId))
      return
    }
    let timer: { cancel(): void } | null = null
    const unsubscribe = deps.registrations.subscribe((registered) => {
      if (registered !== nodeId) return
      unsubscribe()
      timer?.cancel()
      void run(nodeId).finally(() => pending.delete(nodeId))
    })
    timer = setTimer(() => {
      unsubscribe()
      pending.delete(nodeId)
      deps.log.warn('Expired mesh leaf not renewed: the node did not register in time', {
        tags: { nodeId },
        meta: { waitedMs: timeoutMs },
      })
    }, timeoutMs)
  }
}
