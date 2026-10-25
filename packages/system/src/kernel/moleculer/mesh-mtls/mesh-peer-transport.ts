/**
 * Hub-side telemetry: how an agent node reached the mesh transporter.
 * The clear mesh port is retired — only mutual TLS is offered on the hub.
 */

/** How a node reaches the hub (badge / topology). */
export type MeshTransport = 'tls' | 'clear'

/** The leaf a node presented on its live mutual-TLS connection. */
export interface MeshPeerLeaf {
  readonly serial: string
  readonly fingerprint: string
  readonly notBefore: number
  readonly notAfter: number
  /** The remote address of the node's live mesh socket, as the HUB sees it (never self-reported). */
  readonly remoteAddress?: string
}

export interface MeshPeerTransportLookup {
  transportOf(nodeId: string): MeshTransport | undefined
  /** The leaf `nodeId` presented at its last handshake, while it is connected. */
  peerLeaf?(nodeId: string): MeshPeerLeaf | undefined
  /** Close every live mutual-TLS socket of `nodeId`. Returns how many were closed. */
  dropPeer?(nodeId: string): number
  /**
   * Whether `nodeId` is a certificate-verified mesh peer (D857): its leaf chains to the mesh CA,
   * its CN is `nodeId` and the serial is not revoked. The hub's mesh gate reads this.
   */
  isVerifiedPeer?(nodeId: string): boolean
}

const LOOKUP_SLOT = Symbol.for('camstack.cluster.mesh-peer-transport-lookup')

/** Published by the hub broker owner; cleared on shutdown. */
export function setProcessMeshPeerTransportLookup(lookup: MeshPeerTransportLookup | null): void {
  if (lookup === null) Reflect.deleteProperty(globalThis, LOOKUP_SLOT)
  else Reflect.set(globalThis, LOOKUP_SLOT, lookup)
}

function isMeshPeerTransportLookup(value: unknown): value is MeshPeerTransportLookup {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'transportOf') === 'function'
  )
}

function getProcessMeshPeerTransportLookup(): MeshPeerTransportLookup | null {
  const value: unknown = Reflect.get(globalThis, LOOKUP_SLOT)
  return isMeshPeerTransportLookup(value) ? value : null
}

/** `tls` / `clear` for an agent as the hub sees it; `undefined` off the hub. */
export function getProcessNodeMeshTransport(nodeId: string): MeshTransport | undefined {
  return getProcessMeshPeerTransportLookup()?.transportOf(nodeId)
}

/** The leaf `nodeId` presented on its live connection, or `undefined`. */
export function getProcessPeerLeaf(nodeId: string): MeshPeerLeaf | undefined {
  return getProcessMeshPeerTransportLookup()?.peerLeaf?.(nodeId)
}

/** True when the hub's transporter holds a certificate-verified mesh peer called `nodeId` (D857). */
export function isProcessVerifiedMeshPeer(nodeId: string): boolean {
  return getProcessMeshPeerTransportLookup()?.isVerifiedPeer?.(nodeId) === true
}

/** Disconnect `nodeId` (closes its mutual-TLS sockets). `0` when none were open. */
export function dropProcessPeer(nodeId: string): number {
  return getProcessMeshPeerTransportLookup()?.dropPeer?.(nodeId) ?? 0
}

// ── Registration completion (D3) ─────────────────────────────────────────
//
// A mutual-TLS handshake only proves WHO connected. The node is usable (its
// capabilities routable) when its `registerNode` has landed. The hub announces that
// moment here, so a renewal can wait for it instead of scanning.

type RegistrationListener = (nodeId: string, addonIds?: readonly string[]) => void
const REGISTRATION_SLOT = Symbol.for('camstack.cluster.node-registration-listeners')

function registrationListeners(): Set<RegistrationListener> {
  const existing: unknown = Reflect.get(globalThis, REGISTRATION_SLOT)
  if (existing instanceof Set) return existing as Set<RegistrationListener>
  const created = new Set<RegistrationListener>()
  Reflect.set(globalThis, REGISTRATION_SLOT, created)
  return created
}

/** Subscribe to "node X finished registering". Returns the unsubscribe. */
export function onProcessNodeRegistered(listener: RegistrationListener): () => void {
  const listeners = registrationListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Called by the hub when a node's `registerNode` has been applied. `addonIds` is what that
 * registration carried (a node's own addons and its children's, D3), so a waiter can tell the
 * registration of a node that came back WHOLE from the first one of a node that lost its children.
 */
export function emitProcessNodeRegistered(nodeId: string, addonIds?: readonly string[]): void {
  for (const listener of [...registrationListeners()]) {
    try {
      listener(nodeId, addonIds)
    } catch {
      /* a listener must not break registration */
    }
  }
}
