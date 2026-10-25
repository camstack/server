/**
 * `resolveTierSlot` — pure helper: given an owner's profile slots, a
 * deviceId, and a preferred tier, resolve WHICH assigned tier camStream to
 * consume.
 *
 * Slice 3b (ADAPTIVE-target WebRTC live-view for remote-owned cameras,
 * lazy-per-tier). The exact-tier slot wins when it is assigned; otherwise
 * falls back through the canonical `CAM_PROFILE_ORDER` (high→mid→low) — the
 * same single-source tier order used by `stream-broker-manager` and the
 * analogous no-hints tier-selection fallback in `broker-webrtc-server.ts`.
 */
import { CAM_PROFILE_ORDER } from '@camstack/types'
import type { CamProfile, ProfileSlot } from '@camstack/types'

/** One resolved tier slot's addressing info. */
export interface ResolvedTierSlot {
  readonly camStreamId: string
  readonly profile: CamProfile
}

/**
 * Resolve the camStream feeding `deviceId` at `preferredTier`. Prefers an
 * exact-tier match; when that tier is unassigned, falls back through
 * `TIER_PREFERENCE` order to the first assigned tier. Returns `null` when
 * the device has no assigned slot at all. Pure; never mutates `slots`.
 */
export function resolveTierSlot(
  slots: readonly ProfileSlot[],
  deviceId: number,
  preferredTier: CamProfile,
): ResolvedTierSlot | null {
  const deviceSlots = slots.filter((slot) => slot.deviceId === deviceId)

  const exact = deviceSlots.find(
    (slot) => slot.profile === preferredTier && slot.sourceCamStreamId !== null,
  )
  if (exact && exact.sourceCamStreamId !== null) {
    return { camStreamId: exact.sourceCamStreamId, profile: exact.profile }
  }

  for (const tier of CAM_PROFILE_ORDER) {
    const match = deviceSlots.find(
      (slot) => slot.profile === tier && slot.sourceCamStreamId !== null,
    )
    if (match && match.sourceCamStreamId !== null) {
      return { camStreamId: match.sourceCamStreamId, profile: match.profile }
    }
  }

  return null
}
