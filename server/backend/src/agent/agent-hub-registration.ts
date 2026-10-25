/**
 * The agent's upward capability registration (D3).
 *
 * The hub forgets an agent's registration on every `$node.disconnected` the HUB
 * sees. That event is not symmetric: Moleculer marks a node offline on gossip
 * from a third node, on a failed write, on a heartbeat timeout, and the agent,
 * whose own view of the hub never broke, sees none of it. On 2026-10-14 the hub
 * flapped two agents offline/online every 2–6 s for ~35 min; each flap wiped the
 * agent's capabilities on the hub and nothing told the agent to send them again.
 *
 * So the registration follows the HUB'S CONNECTION and the hub's own ask, not
 * the agent's view of itself:
 *  - every time the hub node connects, the complete manifest is sent again;
 *  - the hub may ask for it (`$agent.requestRegistration`, sent on the hub's
 *    own `$node.connected`);
 *  - a child runner registering, an addon reload and boot send it too.
 *
 * Who the agent is comes from its certificate (D857): there is no join to wait
 * for and no secret to prove. If the hub refuses the registration because it
 * does not accept this agent's certificate (revoked, or issued by another CA),
 * `onCertificateRefused` says so and the retry loop keeps trying — the operator
 * re-pairs, and the next attempt succeeds.
 *
 * Each send is ONE atomic `$hub.registerNode` carrying the full set; sends are
 * coalesced (one in flight, at most one queued, the manifest built when it
 * goes). Nothing waits on a timer: the triggers are events, the retry is the ack.
 */
import {
  callRegisterNodeWithRetry,
  meshErrorType,
  MESH_NODE_UNAUTHENTICATED_TYPE,
  type RegisterNodeBroker,
  type RegisterNodeParams,
} from '@camstack/system'

export interface AgentHubRegistrationOptions {
  /** The COMPLETE manifest, built at send time. */
  readonly buildManifest: () => RegisterNodeParams
  /** The CURRENT broker (the agent replaces it on reconnect). */
  readonly broker: () => RegisterNodeBroker
  readonly signal?: AbortSignal
  readonly log: (message: string) => void
  /** The hub acked a registration. */
  readonly onAcked?: () => void
  /** The hub refused the registration because it does not accept this agent's certificate. */
  readonly onCertificateRefused?: (err: unknown) => void
}

export interface AgentHubRegistration {
  /** Send the complete manifest (coalesced). */
  trigger(reason: string): void
  /** The hub node connected: its view of this agent was reset, so the full set goes again. */
  onHubConnected(): void
}

export function createAgentHubRegistration(
  opts: AgentHubRegistrationOptions,
): AgentHubRegistration {
  let sending = false
  let queuedReason: string | null = null

  const send = (reason: string): void => {
    sending = true
    const manifest = opts.buildManifest()
    const bindings = manifest.addons.reduce((n, a) => n + a.capabilities.length, 0)
    // Each attempt resolves the CURRENT broker: a retry that outlives a
    // `reconnect()` must not keep calling the stopped one.
    const broker: RegisterNodeBroker = {
      call: (action, params, callOpts) => opts.broker().call(action, params, callOpts),
    }
    callRegisterNodeWithRetry(broker, manifest, {
      target: 'hub',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      log: opts.log,
      onAttemptFailed: (err) => {
        if (meshErrorType(err) === MESH_NODE_UNAUTHENTICATED_TYPE) opts.onCertificateRefused?.(err)
      },
    })
      .then(() => {
        opts.log(
          `[register-node] the hub acked this node's capabilities: ${manifest.addons.length} addon(s), ${bindings} binding(s) (${reason})`,
        )
        opts.onAcked?.()
      })
      .catch(() => {
        // Aborted: shutting down.
      })
      .finally(() => {
        sending = false
        const next = queuedReason
        queuedReason = null
        if (next !== null) trigger(next)
      })
  }

  const trigger = (reason: string): void => {
    if (sending) {
      queuedReason = reason
      return
    }
    send(reason)
  }

  return {
    trigger,
    onHubConnected() {
      trigger('hub connected')
    },
  }
}
