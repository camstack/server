/** One adopted child, reduced to what channel reconciliation needs. */
export interface AdoptedChildChannel {
  readonly deviceId: number
  readonly stableId: string
  readonly channel?: number
}

/** One discovered channel, reduced to what channel reconciliation needs. */
export interface DiscoveredChannel {
  readonly childNativeId: string
  readonly rtspChannel?: number
}

/** A child whose persisted channel disagrees with the hub, and what it should become. */
export interface ChannelRepair {
  readonly deviceId: number
  readonly stableId: string
  /** `null` when the child had no channel at all — the case that hides it entirely. */
  readonly from: number | null
  readonly to: number
}

/**
 * Match adopted children to the hub's own channel list by IDENTITY, then report the
 * ones whose persisted `channel` is missing or wrong.
 *
 * A child's stableId ENDS with `-${childNativeId}` (the prefix is the integration it was
 * adopted into, or the retired Hub's stableId for a migrated child), and `childNativeId` is built
 * from the camera's UID — so identity survives a channel move, while `channel` does not.
 * The hub is the authority on which slot a UID currently occupies.
 *
 * Why this exists: `loadAdoptedChildrenByChannel` keys the adopted set on the persisted
 * `channel` alone. A child that lost it is absent from that map, so the discovery panel
 * renders it `alreadyAdopted: false` — one click away from being adopted a SECOND time —
 * and `routeSimpleEvent` silently drops every push for its slot. Observed live on
 * 2026-09-04 with an Argus MagiCam that was actually on channel 3.
 *
 * Pure: no I/O. A discovered entry with no channel, or with no adopted child, is skipped —
 * this repairs what exists, it never adopts.
 */
export function planChannelReconciliation(
  discovered: readonly DiscoveredChannel[],
  children: readonly AdoptedChildChannel[],
): readonly ChannelRepair[] {
  const repairs: ChannelRepair[] = []
  for (const entry of discovered) {
    if (typeof entry.rtspChannel !== 'number') continue
    const child = children.find((c) => c.stableId.endsWith(`-${entry.childNativeId}`))
    if (child === undefined) continue
    if (child.channel === entry.rtspChannel) continue
    repairs.push({
      deviceId: child.deviceId,
      stableId: child.stableId,
      from: child.channel ?? null,
      to: entry.rtspChannel,
    })
  }
  return repairs
}
