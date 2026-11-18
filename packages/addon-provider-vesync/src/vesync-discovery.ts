import {
  DeviceType,
  type DiscoveredChildDevice,
  fanControlCapability,
  humidifierCapability,
  switchCapability,
} from '@camstack/types'
import type {
  VeSyncDeviceSnapshot,
  VeSyncHumidifierSnapshot,
  VeSyncPurifierSnapshot,
} from './vesync-client-contract.js'

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

/** The `childNativeId` a discovered VeSync humidifier candidate is keyed on. */
export function humidifierNativeId(accountId: string, cid: string): string {
  return `${accountId}:humidifier:${cid}`
}

/** Extract the VeSync `cid` from a {@link humidifierNativeId} value, or null. */
export function parseHumidifierNativeId(childNativeId: string): string | null {
  const marker = ':humidifier:'
  const idx = childNativeId.lastIndexOf(marker)
  if (idx < 0) return null
  const cid = childNativeId.slice(idx + marker.length)
  return cid.length > 0 ? cid : null
}

/** Inputs for {@link buildHumidifierCandidates}. */
export interface BuildHumidifierCandidatesInput {
  readonly accountId: string
  readonly accountName: string
  readonly humidifiers: readonly VeSyncHumidifierSnapshot[]
  /** Adopted CamStack device id PER humidifier `cid`, or null when not adopted. */
  readonly adoptedDeviceIdByCid: Readonly<Record<string, number | null>>
}

/** One {@link DeviceType.Humidifier} adoption candidate per VeSync humidifier. Pure. */
export function buildHumidifierCandidates(
  input: BuildHumidifierCandidatesInput,
): readonly DiscoveredChildDevice[] {
  return input.humidifiers.map((humidifier) => {
    const adoptedDeviceId = input.adoptedDeviceIdByCid[humidifier.nativeId] ?? null
    return {
      childNativeId: humidifierNativeId(input.accountId, humidifier.nativeId),
      name:
        humidifier.name.length > 0
          ? humidifier.name
          : `${input.accountName} — humidifier ${humidifier.nativeId}`,
      type: DeviceType.Humidifier,
      status: humidifier.online ? 'online' : 'offline',
      metadata: {
        manufacturer: 'VeSync',
        integration: 'vesync',
        ...(humidifier.model !== undefined ? { model: humidifier.model } : {}),
      },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      // display / humidity / water-low fan out as accessory children.
      capabilities: [humidifierCapability.name],
    } satisfies DiscoveredChildDevice
  })
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
  /** Every purifier and humidifier on the account. */
  readonly devices: readonly VeSyncDeviceSnapshot[]
  /** Adopted CamStack device id per device `cid`, or null when not adopted. */
  readonly adoptedDeviceIdByCid: Readonly<Record<string, number | null>>
}

/**
 * One Fan candidate per purifier and one Humidifier candidate per humidifier. The account
 * itself is never proposed. Pure.
 */
export function buildVeSyncCandidates(
  input: BuildVeSyncCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const purifiers = buildPurifierCandidates({
    accountId: input.integrationId,
    accountName: input.accountName,
    purifiers: input.devices.filter((d): d is VeSyncPurifierSnapshot => d.kind === 'purifier'),
    adoptedDeviceIdByCid: input.adoptedDeviceIdByCid,
  })
  const humidifiers = buildHumidifierCandidates({
    accountId: input.integrationId,
    accountName: input.accountName,
    humidifiers: input.devices.filter(
      (d): d is VeSyncHumidifierSnapshot => d.kind === 'humidifier',
    ),
    adoptedDeviceIdByCid: input.adoptedDeviceIdByCid,
  })
  return [...purifiers, ...humidifiers]
}
