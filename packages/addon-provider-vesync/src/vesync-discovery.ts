import {
  DeviceType,
  type DiscoveredChildDevice,
  fanControlCapability,
  switchCapability,
} from '@camstack/types'
import type { VeSyncPurifierSnapshot } from './vesync-client-contract.js'

/**
 * The `childNativeId` a discovered VeSync purifier candidate is keyed on. The
 * VeSync device `cid` is stable across reboots; it is namespaced under the
 * account stableId so two accounts never collide.
 */
export function purifierNativeId(accountId: string, cid: string): string {
  return `${accountId}:purifier:${cid}`
}

/** Extract the VeSync `cid` from a {@link purifierNativeId} value, or null. */
export function parsePurifierNativeId(childNativeId: string): string | null {
  const marker = ':purifier:'
  const idx = childNativeId.lastIndexOf(marker)
  if (idx < 0) return null
  const cid = childNativeId.slice(idx + marker.length)
  return cid.length > 0 ? cid : null
}

/** Inputs for {@link buildPurifierCandidates}. */
export interface BuildPurifierCandidatesInput {
  readonly accountId: string
  readonly accountName: string
  readonly purifiers: readonly VeSyncPurifierSnapshot[]
  /** Adopted CamStack device id PER purifier `cid`, or null when not adopted. */
  readonly adoptedDeviceIdByCid: Readonly<Record<string, number | null>>
}

/**
 * Build one {@link DeviceType.Fan} adoption candidate per VeSync purifier on the
 * account. Pure — no I/O. Unit-testable in isolation.
 */
export function buildPurifierCandidates(
  input: BuildPurifierCandidatesInput,
): readonly DiscoveredChildDevice[] {
  return input.purifiers.map((purifier) => {
    const adoptedDeviceId = input.adoptedDeviceIdByCid[purifier.nativeId] ?? null
    const name =
      purifier.name.length > 0
        ? purifier.name
        : `${input.accountName} — purifier ${purifier.nativeId}`
    return {
      childNativeId: purifierNativeId(input.accountId, purifier.nativeId),
      name,
      type: DeviceType.Fan,
      status: purifier.online ? 'online' : 'offline',
      // The authoritative model is re-read from the live snapshot on adopt; the
      // candidate carries it in `metadata.model` for the adoption panel.
      metadata: {
        manufacturer: 'VeSync',
        integration: 'vesync',
        ...(purifier.model !== undefined ? { model: purifier.model } : {}),
      },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      // The Fan device registers `switch` (on/off) + `fan-control` (speed/preset)
      // on itself; child-lock / display / air-quality / filter-life fan out as
      // accessory children.
      capabilities: [switchCapability.name, fanControlCapability.name],
    } satisfies DiscoveredChildDevice
  })
}
