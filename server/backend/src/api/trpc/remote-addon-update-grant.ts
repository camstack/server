/**
 * The scoped grant that lets an agent update an addon on ITS OWN node (D842).
 *
 * `addons.updatePackage` is deliberately not on `REMOTE_PRIVILEGE_ALLOWLIST`:
 * that list is by path, and a path grant would let any enrolled node deploy any
 * package version to any other node. This rule grants the path only under three
 * conditions, all decided from what the hub knows, never from what the caller
 * says about itself:
 *
 *  1. the target `nodeId` IS the caller's authenticated node id (the mesh
 *     identity Moleculer reports for the calling node; the request body names a
 *     target, it never names the caller);
 *  2. the version asked for IS the version the hub itself has installed for that
 *     package — the one its back-fill restores on every reconnect. An agent can
 *     therefore only converge to the hub's record, never inject an older, newer
 *     or unpublished build;
 *  3. the package exists on the hub.
 *
 * Every decision, allowed or refused, is written to the auth audit trail.
 */

/** Why a call was refused; the sentence reaches the agent UI verbatim. */
export interface RemoteUpdateDecision {
  readonly allowed: boolean
  readonly reason: string | null
}

export interface RemoteUpdateAuditEvent {
  readonly action: 'agent-addon-update' | 'agent-addon-update-refused'
  readonly userId: string
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export interface RemoteUpdateGrantDeps {
  /** The version the hub has installed for `name`; `null` when it has none. */
  readonly hubInstalledVersion: (name: string) => string | null
  /** Writes the audit row. Never throws (the audit log guarantees it). */
  readonly audit: (event: RemoteUpdateAuditEvent) => Promise<void>
}

interface UpdateRequest {
  readonly name: string
  readonly version: string
  readonly nodeId: string
}

function readRequest(input: unknown): UpdateRequest | null {
  if (input === null || typeof input !== 'object') return null
  const name: unknown = Reflect.get(input, 'name')
  const version: unknown = Reflect.get(input, 'version')
  const nodeId: unknown = Reflect.get(input, 'nodeId')
  if (typeof name !== 'string' || name === '') return null
  if (typeof version !== 'string' || version === '') return null
  if (typeof nodeId !== 'string' || nodeId === '') return null
  return { name, version, nodeId }
}

function decide(
  callerNodeId: string,
  input: unknown,
  deps: RemoteUpdateGrantDeps,
): RemoteUpdateDecision & { readonly detail: Record<string, string> } {
  const request = readRequest(input)
  if (request === null) {
    return {
      allowed: false,
      reason: 'addons.updatePackage from a node needs { name, version, nodeId } — all three',
      detail: { reason: 'malformed' },
    }
  }
  const detail = { name: request.name, version: request.version, target: request.nodeId }
  if (request.nodeId !== callerNodeId) {
    return {
      allowed: false,
      reason: `a node may update packages on its own node only: "${callerNodeId}" asked for "${request.nodeId}"`,
      detail: { ...detail, reason: 'other-node' },
    }
  }
  const hubVersion = deps.hubInstalledVersion(request.name)
  if (hubVersion === null) {
    return {
      allowed: false,
      reason: `the hub does not install ${request.name}, so it has no version to bring "${callerNodeId}" to`,
      detail: { ...detail, reason: 'not-on-hub' },
    }
  }
  if (request.version !== hubVersion) {
    return {
      allowed: false,
      reason: `a node can only be brought to the hub's version: the hub records ${request.name}@${hubVersion}, not ${request.version}`,
      detail: { ...detail, reason: 'version-differs', hubVersion },
    }
  }
  return { allowed: true, reason: null, detail }
}

/** Decide, audit, and return the decision. */
export async function authorizeRemoteUpdatePackage(
  callerNodeId: string,
  input: unknown,
  deps: RemoteUpdateGrantDeps,
): Promise<RemoteUpdateDecision> {
  const { allowed, reason, detail } = decide(callerNodeId, input, deps)
  await deps.audit({
    action: allowed ? 'agent-addon-update' : 'agent-addon-update-refused',
    userId: `node:${callerNodeId}`,
    detail,
  })
  return { allowed, reason }
}
