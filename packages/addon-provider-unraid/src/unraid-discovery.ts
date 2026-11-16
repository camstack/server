import {
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  gatewayDeviceName,
} from '@camstack/types'
import { z } from 'zod'
import type { UnraidContainerInfo, UnraidSnapshot, UnraidVmInfo } from './unraid-client-contract.js'
import { localIdOf } from './unraid-mapping.js'

/** The `childNativeId` of the server itself (the Gateway), one per integration. */
export const UNRAID_GATEWAY_ID = 'gateway'

/**
 * The `childNativeId` of the single instance Container, one per integration. The
 * Container fans every array / disk / CPU / notification entity out as accessory
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

/** Discriminated result of parsing a `childNativeId`. */
export type ParsedUnraidNativeId =
  | { readonly kind: 'gateway' }
  | { readonly kind: 'instance' }
  | { readonly kind: 'workload'; readonly ref: UnraidWorkloadRef }
  | null

/** Parse a candidate `childNativeId` back into what it names (null: not ours). */
export function parseUnraidNativeId(childNativeId: string): ParsedUnraidNativeId {
  if (childNativeId === UNRAID_GATEWAY_ID) return { kind: 'gateway' }
  if (childNativeId === UNRAID_INSTANCE_ID) return { kind: 'instance' }
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
    /** Hostname the server reported. Absent: the gateway is named "Unraid". */
    readonly hostname?: string | null
  }
  /** The server's containers; `null` when the list could not be read (none proposed). */
  readonly dockers: readonly UnraidContainerInfo[] | null
  /** The server's VMs; `null` when the list could not be read (none proposed). */
  readonly vms: readonly UnraidVmInfo[] | null
  /** Adopted device id per native id (`gateway`, `instance`, `docker:…`, `vm:…`). */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Unraid', integration: 'unraid' } as const

/**
 * The server ({@link DeviceType.Gateway}, with a link to its WebGUI), the SINGLE
 * {@link DeviceType.Container} of its instance, and one candidate per Docker container and
 * per VM — all top-level SIBLINGS, none nests another (the UniFi model: a controller's
 * Gateway beside one candidate per infra device and per client). The array / disk / CPU /
 * notification entities materialise as the instance's accessory children. Pure.
 */
export function buildUnraidCandidates(
  input: BuildUnraidCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const status = input.server.online ? 'online' : 'offline'
  const gatewayAdopted = input.adopted.get(UNRAID_GATEWAY_ID) ?? null
  const instanceAdopted = input.adopted.get(UNRAID_INSTANCE_ID) ?? null
  const workload = (ref: UnraidWorkloadRef, name: string, model: string): DiscoveredChildDevice => {
    const childNativeId = workloadNativeId(ref)
    const adoptedDeviceId = input.adopted.get(childNativeId) ?? null
    return {
      childNativeId,
      name,
      type: DeviceType.Generic,
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
  return [
    {
      childNativeId: UNRAID_GATEWAY_ID,
      name: gatewayDeviceName('Unraid', input.server.hostname),
      type: DeviceType.Gateway,
      status,
      metadata: METADATA,
      alreadyAdopted: gatewayAdopted !== null,
      adoptedDeviceId: gatewayAdopted,
      capabilities: [deviceAdminLinkCapability.name],
    },
    {
      childNativeId: UNRAID_INSTANCE_ID,
      name: input.server.name,
      type: DeviceType.Container,
      status,
      metadata: METADATA,
      alreadyAdopted: instanceAdopted !== null,
      adoptedDeviceId: instanceAdopted,
    },
    ...containers,
    ...vms,
  ]
}
