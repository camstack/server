/**
 * Registration-handshake client (D3). A node, once it has finished
 * mounting every service, calls this to push its COMPLETE capability
 * manifest to its parent (`$hub.registerNode` for hub children + agents,
 * `$agent.registerNode` for an agent's own children). Retries the CALL
 * until the parent acks — reliability is the ack, never a timer.
 */
import type {
  NodeRootPackageInfo,
  RegisteredAddonManifest,
  RegisteredNativeCap,
  RegisterNodeParams,
} from './node-registry.js'

/** Minimal broker surface this client needs. */
interface RegisterNodeBroker {
  call(action: string, params: unknown, opts?: { nodeID?: string }): Promise<unknown>
}

interface CallRegisterNodeOptions {
  /** `'hub'` → `$hub.registerNode`; `'agent'` → `$agent.registerNode`. */
  readonly target: 'hub' | 'agent'
  /** Required when target is `'agent'` — the agent's nodeID to route to. */
  readonly targetNodeId?: string
  /** First retry delay; doubles each attempt, capped at 5000ms. Default 250. */
  readonly baseDelayMs?: number
  /** Abort the retry loop (e.g. on node shutdown). */
  readonly signal?: AbortSignal
  /** Optional logger for retry diagnostics. */
  readonly log?: (msg: string) => void
  /** Told about every failed attempt (the loop keeps going); lets the caller surface a cause. */
  readonly onAttemptFailed?: (err: unknown) => void
}

/**
 * Build a `RegisterNodeParams` from a node id, its per-addon manifests,
 * optionally its device-scoped native caps, and optionally the node's
 * root-package identity (runtime-updatable node packages: version
 * visibility). `nativeCaps` is omitted entirely on the first handshake;
 * `rootPackage` is omitted by nodes that do not run the root-package model
 * (UDS children). Who the sender is comes from its certificate (D857), not
 * from the payload.
 */
function buildNodeManifest(
  nodeId: string,
  addons: readonly RegisteredAddonManifest[],
  nativeCaps?: readonly RegisteredNativeCap[],
  rootPackage?: NodeRootPackageInfo,
): RegisterNodeParams {
  const params: RegisterNodeParams = {
    nodeId,
    addons: addons.map((a) => ({ addonId: a.addonId, capabilities: [...a.capabilities] })),
    ...(nativeCaps === undefined
      ? {}
      : {
          nativeCaps: nativeCaps.map((n) => ({
            capName: n.capName,
            addonId: n.addonId,
            deviceIds: [...n.deviceIds],
          })),
        }),
    ...(rootPackage === undefined
      ? {}
      : { rootPackage: { name: rootPackage.name, version: rootPackage.version } }),
  }
  return params
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

/**
 * Call `<target>.registerNode` and retry until the parent acks. The loop
 * terminates ONLY on a successful ack or an abort — there is no fixed
 * attempt cap, because the real terminating condition is "the hub
 * received it", not "we tried N times".
 */
async function callRegisterNodeWithRetry(
  broker: RegisterNodeBroker,
  params: RegisterNodeParams,
  opts: CallRegisterNodeOptions,
): Promise<void> {
  const action = opts.target === 'hub' ? '$hub.registerNode' : '$agent.registerNode'
  // Pin the destination node for `$hub.*`.
  // Without `nodeID`, Moleculer requires registry.actions.isAvailable — on the
  // dual-port TLS mesh that catalog sync often lags (or stays one-way), so
  // registerNode looped on "Service … is not available".
  const callOpts =
    opts.target === 'hub'
      ? { nodeID: 'hub' }
      : opts.target === 'agent' && opts.targetNodeId
        ? { nodeID: opts.targetNodeId }
        : undefined
  const base = opts.baseDelayMs ?? 250
  let attempt = 0
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted')
    try {
      await broker.call(action, params, callOpts)
      if (attempt > 0) opts.log?.(`[register-node] ${action} acked after ${attempt + 1} attempt(s)`)
      return
    } catch (err) {
      opts.onAttemptFailed?.(err)
      attempt++
      const wait = Math.min(base * 2 ** (attempt - 1), 5000)
      opts.log?.(
        `[register-node] ${action} failed (attempt ${attempt}) — retrying in ${wait}ms: ${err instanceof Error ? err.message : String(err)}`,
      )
      await delay(wait, opts.signal)
    }
  }
}

export { callRegisterNodeWithRetry, buildNodeManifest }
export type { RegisterNodeBroker, CallRegisterNodeOptions }
