import {
  DeviceType,
  type DiscoveredChildDevice,
  fanControlCapability,
  gatewayDeviceName,
  switchCapability,
} from '@camstack/types'
import type { VeSyncPurifierSnapshot } from './vesync-client-contract.js'

/** The `childNativeId` of the account Gateway, one per integration. A sibling of the purifiers. */
export const VESYNC_GATEWAY_NATIVE_ID = 'account'

/** Stable id of the Gateway device for an integration. */
export function gatewayStableId(integrationId: string): string {
  return `vesync:${integrationId}:${VESYNC_GATEWAY_NATIVE_ID}`
}

/**
 * The `childNativeId` a discovered VeSync purifier candidate is keyed on. The
 * VeSync device `cid` is stable across reboots; it is namespaced under the
 * integration id so two accounts never collide.
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

/** Inputs for {@link buildVeSyncCandidates}. */
export interface BuildVeSyncCandidatesInput {
  readonly integrationId: string
  readonly accountName: string
  /** Whether the integration's client is connected. */
  readonly online: boolean
  readonly purifiers: readonly VeSyncPurifierSnapshot[]
  /** The adopted Gateway device id, or null. */
  readonly adoptedGatewayId: number | null
  /** Adopted CamStack device id per purifier `cid`, or null when not adopted. */
  readonly adoptedDeviceIdByCid: Readonly<Record<string, number | null>>
}

/**
 * The account Gateway, then one Fan candidate per purifier. The Gateway is a sibling
 * of the purifiers: nothing in this list is a child of it. Pure.
 */
export function buildVeSyncCandidates(
  input: BuildVeSyncCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const gateway: DiscoveredChildDevice = {
    childNativeId: VESYNC_GATEWAY_NATIVE_ID,
    name: gatewayDeviceName('VeSync'),
    type: DeviceType.Gateway,
    status: input.online ? 'online' : 'offline',
    metadata: { manufacturer: 'VeSync', integration: 'vesync' },
    alreadyAdopted: input.adoptedGatewayId !== null,
    adoptedDeviceId: input.adoptedGatewayId,
    capabilities: [],
  }
  const purifiers = buildPurifierCandidates({
    accountId: input.integrationId,
    accountName: input.accountName,
    purifiers: input.purifiers,
    adoptedDeviceIdByCid: input.adoptedDeviceIdByCid,
  })
  return [gateway, ...purifiers]
}
