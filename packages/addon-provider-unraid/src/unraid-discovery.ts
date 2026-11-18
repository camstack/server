import {
  batteryCapability,
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  powerMeterCapability,
  workloadCapability,
} from '@camstack/types'
import { z } from 'zod'
import type {
  UnraidContainerInfo,
  UnraidSnapshot,
  UnraidUpsInfo,
  UnraidVmInfo,
} from './unraid-client-contract.js'
import { localIdOf } from './unraid-mapping.js'

/**
 * The `childNativeId` of the server itself, the single workload Host, one per integration
 * (D1064: there is no Gateway device beside it). It carries the WebGUI link and the server's
 * identifiers, and fans every array / disk / CPU / notification entity out as accessory
 * children. Docker containers and VMs are NOT its children: each is its own candidate.
 */
export const UNRAID_INSTANCE_ID = 'instance'

/**
 * How an adopted Docker container or VM is found again on the server. A container by its
 * name: Unraid recreates a container, with a new id, on every update. A VM by the local
 * part of its id, the libvirt domain UUID (the prefix is the server hash every id shares).
 */
export const UnraidWorkloadRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('docker'), name: z.string().min(1) }),
  z.object({ kind: z.literal('vm'), localId: z.string().min(1) }),
])
export type UnraidWorkloadRef = z.infer<typeof UnraidWorkloadRefSchema>

const UPS_PREFIX = 'ups:'
const DOCKER_PREFIX = 'docker:'
const VM_PREFIX = 'vm:'

/** The `childNativeId` of a workload candidate: `docker:<name>` or `vm:<domain uuid>`. */
export function workloadNativeId(ref: UnraidWorkloadRef): string {
  return ref.kind === 'docker' ? `${DOCKER_PREFIX}${ref.name}` : `${VM_PREFIX}${ref.localId}`
}

/** The workload a container of the live list is adopted as. */
export function dockerRef(container: UnraidContainerInfo): UnraidWorkloadRef {
  return { kind: 'docker', name: container.name }
}

/** The workload a VM of the live list is adopted as. */
export function vmRef(vm: UnraidVmInfo): UnraidWorkloadRef {
  return { kind: 'vm', localId: localIdOf(vm.id) }
}

/** The `childNativeId` of a UPS candidate: `ups:<local part of its id>`. */
export function upsNativeId(ups: Pick<UnraidUpsInfo, 'id'>): string {
  return `${UPS_PREFIX}${localIdOf(ups.id)}`
}

/** Discriminated result of parsing a `childNativeId`. */
export type ParsedUnraidNativeId =
  | { readonly kind: 'instance' }
  | { readonly kind: 'workload'; readonly ref: UnraidWorkloadRef }
  | { readonly kind: 'ups'; readonly localId: string }
  | null

/** Parse a candidate `childNativeId` back into what it names (null: not ours). */
export function parseUnraidNativeId(childNativeId: string): ParsedUnraidNativeId {
  if (childNativeId === UNRAID_INSTANCE_ID) return { kind: 'instance' }
  if (childNativeId.startsWith(UPS_PREFIX)) {
    const localId = childNativeId.slice(UPS_PREFIX.length)
    return localId.length > 0 ? { kind: 'ups', localId } : null
  }
  if (childNativeId.startsWith(DOCKER_PREFIX)) {
    const name = childNativeId.slice(DOCKER_PREFIX.length)
    return name.length > 0 ? { kind: 'workload', ref: { kind: 'docker', name } } : null
  }
  if (childNativeId.startsWith(VM_PREFIX)) {
    const localId = childNativeId.slice(VM_PREFIX.length)
    return localId.length > 0 ? { kind: 'workload', ref: { kind: 'vm', localId } } : null
  }
  return null
}

/** A workload found in a snapshot, with the live item it names. */
export type UnraidWorkloadMatch =
  | { readonly kind: 'docker'; readonly container: UnraidContainerInfo }
  | { readonly kind: 'vm'; readonly vm: UnraidVmInfo }

/**
 * The live container or VM a workload names, or null when it is not in the snapshot —
 * including when that list could not be read (`null` section): unknown, not gone.
 */
export function findWorkload(
  snapshot: UnraidSnapshot | null,
  ref: UnraidWorkloadRef,
): UnraidWorkloadMatch | null {
  if (snapshot === null) return null
  if (ref.kind === 'docker') {
    const container = snapshot.dockers?.find((c) => c.name === ref.name)
    return container === undefined ? null : { kind: 'docker', container }
  }
  const vm = snapshot.vms?.find((v) => localIdOf(v.id) === ref.localId)
  return vm === undefined ? null : { kind: 'vm', vm }
}

/**
 * The live UPS a native id names, or null when it is not in the snapshot — including when the
 * UPS list could not be read (`null` / absent): unknown, not gone.
 */
export function findUps(snapshot: UnraidSnapshot | null, localId: string): UnraidUpsInfo | null {
  return snapshot?.ups?.find((u) => localIdOf(u.id) === localId) ?? null
}

/** The device `stableId` of an Unraid device: `unraid:<integrationId>:<childNativeId>`. */
export function unraidStableId(integrationId: string, nativeId: string): string {
  return `unraid:${integrationId}:${nativeId}`
}

/** Inputs for {@link buildUnraidCandidates}. */
export interface BuildUnraidCandidatesInput {
  /** The server behind the integration: its name, and whether its last poll succeeded. */
  readonly server: {
    readonly name: string
    readonly online: boolean
  }
  /** The server's containers; `null` when the list could not be read (none proposed). */
  readonly dockers: readonly UnraidContainerInfo[] | null
  /** The server's VMs; `null` when the list could not be read (none proposed). */
  readonly vms: readonly UnraidVmInfo[] | null
  /** The server's UPS devices; `null` / absent when the list could not be read (none proposed). */
  readonly ups?: readonly UnraidUpsInfo[] | null
  /** Adopted device id per native id (`instance`, `docker:…`, `vm:…`). */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Unraid', integration: 'unraid' } as const

/**
 * The server itself as the SINGLE {@link DeviceType.Workload} Host (with the link to its
 * WebGUI), and one workload candidate per Docker container and per VM — all top-level
 * SIBLINGS, none nests another. There is no Gateway candidate (D1064). The array / disk / CPU /
 * notification entities materialise as the Host's accessory children. Pure.
 */
export function buildUnraidCandidates(
  input: BuildUnraidCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const status = input.server.online ? 'online' : 'offline'
  const instanceAdopted = input.adopted.get(UNRAID_INSTANCE_ID) ?? null
  const workload = (ref: UnraidWorkloadRef, name: string, model: string): DiscoveredChildDevice => {
    const childNativeId = workloadNativeId(ref)
    const adoptedDeviceId = input.adopted.get(childNativeId) ?? null
    return {
      childNativeId,
      name,
      type: DeviceType.Workload,
      status,
      metadata: { ...METADATA, model },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
    }
  }
  const containers = (input.dockers ?? []).map((c) =>
    workload(dockerRef(c), c.name, 'Docker container'),
  )
  const vms = (input.vms ?? []).map((v) => workload(vmRef(v), v.name, 'Virtual machine'))
  // Each UPS is its own Sensor device (role `ups`), a sibling of the Host: never its child.
  const upsDevices = (input.ups ?? []).map((u): DiscoveredChildDevice => {
    const childNativeId = upsNativeId(u)
    const adoptedDeviceId = input.adopted.get(childNativeId) ?? null
    return {
      childNativeId,
      name: u.name,
      type: DeviceType.Sensor,
      status,
      metadata: { ...METADATA, ...(u.model !== null ? { model: u.model } : {}) },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [batteryCapability.name, powerMeterCapability.name],
    }
  })
  return [
    {
      childNativeId: UNRAID_INSTANCE_ID,
      name: input.server.name,
      type: DeviceType.Workload,
      status,
      metadata: METADATA,
      alreadyAdopted: instanceAdopted !== null,
      adoptedDeviceId: instanceAdopted,
      capabilities: [workloadCapability.name, deviceAdminLinkCapability.name],
    },
    ...containers,
    ...vms,
    ...upsDevices,
  ]
}
