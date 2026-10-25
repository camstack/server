/**
 * The mesh TLS listener must not accept agents before the revocation registry has
 * loaded (D856): until `mesh_node_certificates` is read, the CRL is empty, so a
 * revoked leaf would be accepted - a fail-open on the one list whose job is to refuse.
 *
 * `openMeshTlsWhenRevocationsLoaded` therefore keeps the listener CLOSED while the
 * registry cannot be loaded, and retries; it opens the listener exactly once, after
 * the registry's revocations were replayed into the CRL. The hub itself talks to no
 * one over this listener, so closed means "agents wait", not "the hub is down".
 */
/** What the admin UI shows about the hub's mesh listener (Identity -> Certificates). */
export type MeshTlsListenerState =
  | { readonly state: 'open' }
  | { readonly state: 'closed'; readonly reason: string; readonly since: number }

const STATE_SLOT = Symbol.for('camstack.mesh.tls-listener-state')

export function setProcessMeshTlsListenerState(state: MeshTlsListenerState | null): void {
  if (state === null) Reflect.deleteProperty(globalThis, STATE_SLOT)
  else Reflect.set(globalThis, STATE_SLOT, state)
}

/** `null` before the gate has run at all (no mesh CA yet). */
export function getProcessMeshTlsListenerState(): MeshTlsListenerState | null {
  const value: unknown = Reflect.get(globalThis, STATE_SLOT)
  if (value === null || typeof value !== 'object') return null
  const state: unknown = Reflect.get(value, 'state')
  return state === 'open' || state === 'closed' ? (value as MeshTlsListenerState) : null
}

export interface MeshTlsGateDeps<R> {
  /** Load the registry and replay its revocations into the CRL. `null` when it cannot yet. */
  readonly loadRegistry: () => Promise<R | null>
  /** Open the listener. Called until it succeeds (a failed open is retried), then never again. */
  readonly open: (registry: R) => Promise<void>
  /** Run `fn` again after `ms` (an unref'd timer in production). */
  readonly retry: (fn: () => void, ms: number) => void
  readonly retryMs?: number
  readonly onWaiting?: (attempt: number) => void
  readonly onError?: (error: unknown) => void
  /** Every change of the listener's state, for the status the admin UI reads. */
  readonly onState?: (state: MeshTlsListenerState) => void
  readonly now?: () => number
}

const DEFAULT_RETRY_MS = 15_000

/**
 * Nothing in `run` can reject: a load or an open that throws is reported and retried, so a
 * failure can never become an unhandled rejection that leaves the listener closed in silence.
 */
export function openMeshTlsWhenRevocationsLoaded<R>(deps: MeshTlsGateDeps<R>): Promise<boolean> {
  let attempt = 0
  let opened = false
  const now = deps.now ?? Date.now
  let closedSince: number | null = null
  const closed = (reason: string): void => {
    closedSince ??= now()
    deps.onState?.({ state: 'closed', reason, since: closedSince })
  }
  const run = async (): Promise<boolean> => {
    if (opened) return true
    attempt += 1
    let registry: R | null = null
    try {
      registry = await deps.loadRegistry()
    } catch (error: unknown) {
      deps.onError?.(error)
    }
    if (registry === null) {
      closed('the revocation registry has not loaded - agents are refused')
      deps.onWaiting?.(attempt)
      deps.retry(() => void run(), deps.retryMs ?? DEFAULT_RETRY_MS)
      return false
    }
    try {
      await deps.open(registry)
    } catch (error: unknown) {
      deps.onError?.(error)
      closed('the listener failed to open - retrying')
      deps.retry(() => void run(), deps.retryMs ?? DEFAULT_RETRY_MS)
      return false
    }
    opened = true
    deps.onState?.({ state: 'open' })
    return true
  }
  return run()
}
