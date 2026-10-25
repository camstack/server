/**
 * P2a — per-camera frame-source eligibility (pure predicate).
 *
 * Part of the cross-node pipeline Phase 2 restream-owner model
 * (`docs/superpowers/specs/2026-07-03-pipeline-crossnode-phase2-restream-owner-design.md`
 * §2.3). Rule: **a node N can source camera X's frames iff N can decode
 * locally (it is in `enabledDecoderNodes`) AND (N owns X's source pull, OR N
 * is allowed to run the remote-source leg — dial the owner's compressed
 * restream and decode it locally)**.
 *
 * SAFETY INVARIANT (the P2a contract): while per-camera source ownership is
 * not yet modeled (`sourceOwnerNodeId` absent — no `assignSource` surface
 * exists until P2d), the predicate MUST collapse to exactly the global
 * `enabledDecoderNodes` — bit-identical, order included. That makes P2a a
 * pure refactor with zero behavior change; later phases turn on the
 * per-camera restriction by supplying an owner, and widen it again with
 * `remoteSourcingNodes` once the P2b/P2c transport exists.
 */

export interface FrameSourceEligibilityInput {
  /**
   * Nodes allowed to host video decode sessions (the global
   * `enabledDecoderNodes` multiselect). A node outside this list can NEVER
   * source frames — it has no local shm ring to read from.
   */
  readonly enabledDecoderNodes: readonly string[]
  /**
   * The ONE node that dials this camera's real RTSP and hosts its broker
   * (pre-buffer, WebRTC, restream). Absent = ownership not yet modeled →
   * pre-Phase-2 semantics (every decoder-enabled node is a potential
   * source). P2d backs this with the `assignSource` cap surface.
   */
  readonly sourceOwnerNodeId?: string
  /**
   * Nodes allowed to run the remote-source leg: pull the owner's refcounted
   * restream over the LAN and decode locally. Empty/absent = Phase-2
   * transport off (the safe-rollout default).
   */
  readonly remoteSourcingNodes?: readonly string[]
}

/**
 * The set of nodes that can obtain a given camera's decoded frames.
 *
 * - No `sourceOwnerNodeId` → `enabledDecoderNodes` unchanged (today's
 *   semantics; `remoteSourcingNodes` cannot restrict anything when no owner
 *   restricts first — it only ever WIDENS an owner-restricted set).
 * - With an owner → `enabledDecoderNodes ∩ ({owner} ∪ remoteSourcingNodes)`.
 *
 * Pure: never mutates its inputs; result preserves `enabledDecoderNodes`
 * order.
 */
export function computeFrameSourceNodes(input: FrameSourceEligibilityInput): readonly string[] {
  const { enabledDecoderNodes, sourceOwnerNodeId, remoteSourcingNodes } = input
  if (sourceOwnerNodeId === undefined) return enabledDecoderNodes
  const remote = remoteSourcingNodes ?? []
  return enabledDecoderNodes.filter(
    (nodeId) => nodeId === sourceOwnerNodeId || remote.includes(nodeId),
  )
}
