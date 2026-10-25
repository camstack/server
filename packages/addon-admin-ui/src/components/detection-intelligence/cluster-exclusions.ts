/**
 * Pure state helpers for the SimilarGroupsModal's client-side exclusion set.
 *
 * Clusters returned by `suggestFaceClusters` are EPHEMERAL suggestions over
 * unassigned faces — there is no server-side "excluded" concept. An operator
 * dropping a member from a group only trims the local action set (adopt /
 * select-in-gallery); it never calls the backend.
 */

export interface ClusterView {
  readonly representativeFaceId: string
  readonly faceIds: readonly string[]
  readonly size: number
  readonly cohesion: number
}

/** Toggle faceId in the exclusion set (returns a NEW Set). */
export function toggleExclusion(excluded: ReadonlySet<string>, faceId: string): Set<string> {
  const next = new Set(excluded)
  if (next.has(faceId)) next.delete(faceId)
  else next.add(faceId)
  return next
}

/** Members of the cluster minus exclusions — the action set for adopt/select. */
export function activeMembers(cluster: ClusterView, excluded: ReadonlySet<string>): string[] {
  return cluster.faceIds.filter((id) => !excluded.has(id))
}

/**
 * Members of the cluster the operator can actually SEE (resolved via the
 * parent's `byId` lookup). A cluster can reference faceIds outside the
 * parent's fetch window or excluded by the active filter — those render no
 * card, so they must never be actionable (see `activeMembers`, which should
 * be fed this filtered list rather than the raw `cluster.faceIds`).
 */
export function visibleMembers(
  cluster: ClusterView,
  isVisible: (faceId: string) => boolean,
): string[] {
  return cluster.faceIds.filter((id) => isVisible(id))
}
