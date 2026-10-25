export type ProfileName = 'high' | 'mid' | 'low'
export type DerivedSourceRef =
  | { readonly kind: 'profile'; readonly profile: ProfileName }
  | { readonly kind: 'camStream'; readonly camStreamId: string }

export interface DerivedGraph {
  /** profile → the camStreamId currently assigned to it (may be a `derived:*`), or null. */
  readonly assignments: Readonly<Record<ProfileName, string | null>>
  /** derived camStreamId → its source. */
  readonly derived: Readonly<Record<string, DerivedSourceRef>>
}

/**
 * Would assigning `derivedCamStreamId` to `targetProfile` create a cycle?
 * Model the edge as: targetProfile → derivedCamStreamId (the new assignment), then
 * walk consumption edges (profile → its assigned camStream; a derived → its source
 * profile/stream) and report true if we return to `targetProfile`. A physical
 * camStream is a leaf (no outgoing edge) so it never closes a loop.
 */
export function wouldCycle(
  graph: DerivedGraph,
  derivedCamStreamId: string,
  targetProfile: ProfileName,
): boolean {
  const assignments: Record<ProfileName, string | null> = {
    ...graph.assignments,
    [targetProfile]: derivedCamStreamId, // the hypothetical new assignment
  }
  const seen = new Set<string>()
  // Walk from the derived's own source; if we reach `targetProfile`, it cycles.
  const walkFromCamStream = (camStreamId: string): boolean => {
    if (seen.has(`s:${camStreamId}`)) return false
    seen.add(`s:${camStreamId}`)
    const src = graph.derived[camStreamId]
    if (!src) return false // physical (or unknown) — a leaf, no cycle
    if (src.kind === 'camStream') return walkFromCamStream(src.camStreamId)
    return walkFromProfile(src.profile)
  }
  const walkFromProfile = (profile: ProfileName): boolean => {
    if (profile === targetProfile) return true
    if (seen.has(`p:${profile}`)) return false
    seen.add(`p:${profile}`)
    const assigned = assignments[profile]
    return assigned === null ? false : walkFromCamStream(assigned)
  }
  return walkFromCamStream(derivedCamStreamId)
}
