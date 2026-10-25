export type WebrtcSourceMode =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'remote-adapter'
      readonly ownerNodeId: string
      readonly reachableHost: string
    }
  | { readonly kind: 'unresolvable'; readonly ownerNodeId: string }

export interface WebrtcSourceModeInput {
  readonly ownerNodeId: string
  readonly ownNodeId: string
  readonly reachableHost?: string
}

/**
 * Decide how a WebRTC live-view node sources a camera. Owner==self → the
 * local broker path (unchanged). Owner≠self + reachable → a remote-encoded
 * adapter dialing the owner restream. Owner≠self + no reachableHost →
 * unresolvable (fail fast; a 127.0.0.1 restream URL would dial the wrong box).
 */
export function resolveWebrtcSourceMode(input: WebrtcSourceModeInput): WebrtcSourceMode {
  if (input.ownerNodeId === input.ownNodeId) return { kind: 'local' }
  if (input.reachableHost === undefined)
    return { kind: 'unresolvable', ownerNodeId: input.ownerNodeId }
  return {
    kind: 'remote-adapter',
    ownerNodeId: input.ownerNodeId,
    reachableHost: input.reachableHost,
  }
}
