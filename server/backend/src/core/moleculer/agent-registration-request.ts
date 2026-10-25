/**
 * The hub asks a (re)connected agent for its capability set.
 *
 * The hub drops an agent's registration — and its mesh join — on every
 * `$node.disconnected` it sees (`removeNodeFromRegistry`, `meshGuard.forget`).
 * Moleculer raises that event on the HUB alone when a third node gossips the
 * agent offline, when a write to it fails, or when its heartbeat is late; the
 * agent's own view of the hub never breaks, so nothing on the agent says "send
 * your manifest again". When the hub then sees the agent again
 * (`$node.connected`), it holds an online node with NO capabilities. On
 * 2026-10-14 agent-a and the Mac sat that way for 50 minutes.
 *
 * So on every `$node.connected` of an agent the hub calls
 * `$agent.requestRegistration`: one RPC, on the event, no timer (D3). The
 * agent answers through the one atomic `$hub.registerNode`, joining again
 * first when the hub forgot its join. An agent that predates the action cannot
 * be asked: that is said, with whether the hub holds its registration, so an
 * online-but-capless node is never silent.
 */

export const AGENT_REQUEST_REGISTRATION_ACTION = '$agent.requestRegistration'

/** How the ask ended — for the caller's logs and the tests. */
export type AgentRegistrationRequestOutcome = 'requested' | 'unsupported' | 'failed'

export interface AgentRegistrationRequestDeps {
  call(action: string, params: unknown, opts: { nodeID: string }): Promise<unknown>
  /** Does the hub hold a registration (a `registerNode` manifest) for the node? */
  isRegistered(nodeId: string): boolean
  warn(message: string, nodeId: string, meta: Readonly<Record<string, unknown>>): void
  info(message: string, nodeId: string, meta: Readonly<Record<string, unknown>>): void
}

function errorType(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const type: unknown = Reflect.get(err, 'type')
  return typeof type === 'string' ? type : null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ask `nodeId` to re-send its complete capability manifest. Never throws. */
export async function requestAgentRegistration(
  deps: AgentRegistrationRequestDeps,
  nodeId: string,
): Promise<AgentRegistrationRequestOutcome> {
  try {
    await deps.call(AGENT_REQUEST_REGISTRATION_ACTION, {}, { nodeID: nodeId })
    return 'requested'
  } catch (err) {
    const type = errorType(err)
    const unsupported = type === 'SERVICE_NOT_FOUND' || type === 'SERVICE_NOT_AVAILABLE'
    const registered = deps.isRegistered(nodeId)
    const meta = { registered, error: errorText(err) }
    if (registered) {
      deps.info(
        unsupported
          ? 'agent cannot be asked for its capabilities (it predates $agent.requestRegistration) — the hub holds its registration'
          : 'asking the agent for its capabilities failed — the hub holds its registration',
        nodeId,
        meta,
      )
    } else {
      deps.warn(
        unsupported
          ? 'agent is online and the hub holds NO capability registration for it; it predates $agent.requestRegistration and cannot be asked — if it stays without capabilities, restart it'
          : 'agent is online and the hub holds NO capability registration for it; asking it to re-register failed',
        nodeId,
        meta,
      )
    }
    return unsupported ? 'unsupported' : 'failed'
  }
}
