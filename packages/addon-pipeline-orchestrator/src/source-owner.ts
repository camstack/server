/**
 * P2d — source-owner assignment + per-target runner frame-source selection
 * (pure).
 *
 * Part of the cross-node pipeline Phase 2 restream-owner model
 * (`docs/superpowers/specs/2026-07-03-pipeline-crossnode-phase2-restream-owner-design.md`
 * §2.2 roles, §2.4 step 4). Companion to `frame-source-eligibility.ts` (P2a):
 * that module answers "WHICH nodes may source a camera's frames"; this one
 * answers "WHO owns the camera's single source pull" and "WHAT `frameSource`
 * the attach payload carries for a given detect node".
 *
 * ROLLOUT SAFETY (the P2d contract): both functions are gated by the
 * `remoteSourcingNodes` orchestrator setting (default `[]` = OFF). While OFF,
 * `resolveSourceOwner` keeps ownership UNMODELED (`undefined`) — so the P2a
 * predicate collapses to the global `enabledDecoderNodes`, bit-identical to
 * pre-Phase-2 — and `selectRunnerFrameSource` emits `local-broker` for every
 * target, which is exactly the schema default an absent field produces.
 * Every behavior is therefore identical to today until the knob is populated.
 */
import type { RunnerFrameSource } from '@camstack/types'

/**
 * The set of nodes allowed to run the REMOTE-SOURCE leg — every decode-enabled
 * node EXCEPT the camera-source OWNER (the node that dials the camera). Derived
 * from `enabledDecoderNodes`. When the owner is the hub this equals the old
 * hub-exclusion (byte-identical to Phase 1); when the owner is an agent the hub
 * itself becomes a valid remote-source target.
 *
 * Rollout-safe: when the owner is the only decode node the result is `[]`, which
 * keeps `resolveSourceOwner` unmodeled and every frame source `local-broker`.
 * Pure: preserves input order, never mutates.
 */
export function deriveRemoteSourcingNodes(
  enabledDecoderNodes: readonly string[],
  ownerNodeId: string,
): readonly string[] {
  return enabledDecoderNodes.filter((nodeId) => nodeId !== ownerNodeId)
}

export interface ResolveSourceOwnerInput {
  /**
   * The cluster's default source owner — `clusterRoles.ingestNode` (the single
   * node that dials every camera). When `ingestNode` is the hub (default) this
   * reproduces the original slice-1 behavior (hub dials every camera); when it
   * is an agent, that agent owns every camera's source pull (ingest-off-hub).
   */
  readonly ownerNodeId: string
  /**
   * The rollout knob: nodes allowed to run the remote-source leg. EMPTY =
   * Phase-2 transport OFF → ownership stays unmodeled (pre-P2 semantics).
   */
  readonly remoteSourcingNodes: readonly string[]
  /**
   * Per-camera source assignment, when one exists. Slice-2 seam — backed by
   * the future `assignSource`/`getSourceAssignment` cap surface (T8); no
   * caller populates it yet.
   */
  readonly assignedOwner?: string
}

/**
 * The node that owns a camera's source pull (dials the real RTSP, hosts its
 * broker), or `undefined` while ownership is unmodeled (rollout OFF).
 */
export function resolveSourceOwner(input: ResolveSourceOwnerInput): string | undefined {
  if (input.remoteSourcingNodes.length === 0) return undefined
  return input.assignedOwner ?? input.ownerNodeId
}

export interface SelectRunnerFrameSourceInput {
  /** The node the camera's detection is being attached to. */
  readonly targetNodeId: string
  /** The camera's source-owner ({@link resolveSourceOwner}) — `undefined` = unmodeled. */
  readonly sourceOwnerNodeId: string | undefined
  /** The rollout knob — a remote leg is NEVER emitted for an unlisted node. */
  readonly remoteSourcingNodes: readonly string[]
  /**
   * The owner's LAN-reachable host, resolved from the per-node `reachableHost`
   * override (Cluster UI). Emitted into the remote leg when present so the
   * runner dials it in preference to its `CAMSTACK_HUB_URL` default (optional).
   */
  readonly ownerReachableHost?: string
  /** Operator override for the owner host the runner dials (optional). */
  readonly hubHostnameOverride?: string
}

/**
 * The `frameSource` the attach payload carries for a target node:
 * `local-broker` (today's co-located path) unless ownership is modeled AND
 * the target is a DIFFERENT node AND the target is remote-sourcing
 * authorized — then `remote-restream` naming the owner, so the runner
 * acquires the owner's compressed restream and decodes locally.
 *
 * The authorization re-check is deliberate defense-in-depth: eligibility
 * (`computeFrameSourceNodes`) already excludes unauthorized nodes from
 * placement, but a manual pin or stale assignment slipping through must
 * degrade to the safe local path, never to an unauthorized cross-node pull.
 */
export function selectRunnerFrameSource(input: SelectRunnerFrameSourceInput): RunnerFrameSource {
  const {
    targetNodeId,
    sourceOwnerNodeId,
    remoteSourcingNodes,
    ownerReachableHost,
    hubHostnameOverride,
  } = input
  if (sourceOwnerNodeId === undefined) return { kind: 'local-broker' }
  if (targetNodeId === sourceOwnerNodeId) return { kind: 'local-broker' }
  if (!remoteSourcingNodes.includes(targetNodeId)) return { kind: 'local-broker' }
  return {
    kind: 'remote-restream',
    ownerNodeId: sourceOwnerNodeId,
    ...(ownerReachableHost !== undefined ? { ownerReachableHost } : {}),
    ...(hubHostnameOverride !== undefined ? { hubHostnameOverride } : {}),
  }
}
