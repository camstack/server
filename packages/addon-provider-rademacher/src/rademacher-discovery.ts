import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { coverCapability } from '@camstack/types'

/**
 * Minimal structural subset of a noderademacher {@link import('@apocaliss92/noderademacher').CoverDevice}
 * the discovery code needs. Structurally compatible with the real handle + test
 * fixtures.
 */
export interface DiscoverableCover {
  readonly did: string
  readonly name: string
  readonly model: string
  readonly online: boolean
}

/**
 * The `childNativeId` a discovered cover candidate is keyed on. HomePilot's
 * `did` is stable across reboots, so it IS the native id directly (no prefixing
 * — the hub identity is already carried by the parent).
 */
export function coverNativeId(did: string): string {
  return did
}

export interface BuildCoverCandidatesInput {
  /** Operator-overridable / derived hub label. */
  readonly hubName: string
  /** Current cover handles on the hub. */
  readonly covers: readonly DiscoverableCover[]
  /**
   * Adopted CamStack device id PER HomePilot did, or null when that cover is not
   * yet adopted. A missing key is treated as null.
   */
  readonly adoptedDeviceIdByDid: Readonly<Record<string, number | null>>
}

/**
 * Build one {@link DeviceType.Cover} adoption candidate per HomePilot roller
 * shutter on the hub. Each maps 1:1 to a real adopted device, so the existing
 * per-candidate adopt/release machinery (keyed on `childNativeId`) extends
 * directly. Pure: no I/O.
 */
export function buildCoverCandidates(
  input: BuildCoverCandidatesInput,
): readonly DiscoveredChildDevice[] {
  return input.covers.map((cover) => {
    const adoptedDeviceId = input.adoptedDeviceIdByDid[cover.did] ?? null
    return {
      childNativeId: coverNativeId(cover.did),
      name: cover.name.length > 0 ? cover.name : `${input.hubName} — Cover ${cover.did}`,
      type: DeviceType.Cover,
      status: cover.online ? 'online' : 'offline',
      metadata: cover.model.length > 0 ? { model: cover.model } : {},
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [coverCapability.name],
    } satisfies DiscoveredChildDevice
  })
}
