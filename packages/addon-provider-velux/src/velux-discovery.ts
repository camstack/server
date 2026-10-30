import {
  coverCapability,
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  floodCapability,
  rebootCapability,
} from '@camstack/types'
import type { VeluxNode } from './velux-client-contract.js'
import { nodeNativeKey } from './velux-protocol.js'

const RAIN_SUFFIX = ':rain'
const COVER_SUFFIX = '#cover'
const GATEWAY_SUFFIX = ':gateway'

/** The `childNativeId` of the gateway box itself, one per integration. */
export function gatewayNativeId(integrationId: string): string {
  return `${integrationId}${GATEWAY_SUFFIX}`
}

/**
 * The `childNativeId` of a node's top-level candidate: a plain cover, or the
 * container of a window that carries a rain sensor. It is the node's serial when
 * the gateway reports one (a node id is only an index into the gateway's system
 * table and can be reused after a node is removed), namespaced under the
 * integration so two gateways never collide.
 */
export function nodeNativeId(
  integrationId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return nodeNativeKey(integrationId, node)
}

/** The `childNativeId` of the cover inside a window container. */
export function windowCoverNativeId(
  integrationId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return `${nodeNativeKey(integrationId, node)}${COVER_SUFFIX}`
}

/** The `childNativeId` of the rain sensor inside a window container. */
export function rainNativeId(
  integrationId: string,
  node: { readonly serial: string; readonly nodeId: number },
): string {
  return `${nodeNativeKey(integrationId, node)}${RAIN_SUFFIX}`
}

/** What a top-level native id points at on the integration. */
export type ResolvedNativeId =
  | { readonly kind: 'gateway' }
  /** A window with a rain sensor: adopted as a container of a cover and a rain sensor. */
  | { readonly kind: 'window'; readonly node: VeluxNode }
  /** A single-function product: roller shutter, blind, awning, window without rain. */
  | { readonly kind: 'cover'; readonly node: VeluxNode }

/**
 * Resolve an adoptable native id against the integration's current nodes, or
 * null when none matches. The pieces inside a window container are not
 * adoptable on their own, so their ids resolve to nothing.
 */
export function resolveNativeId(
  integrationId: string,
  nodes: readonly VeluxNode[],
  childNativeId: string,
): ResolvedNativeId | null {
  if (childNativeId === gatewayNativeId(integrationId)) return { kind: 'gateway' }
  for (const node of nodes) {
    if (childNativeId !== nodeNativeId(integrationId, node)) continue
    return node.rainSensor ? { kind: 'window', node } : { kind: 'cover', node }
  }
  return null
}

/** Inputs for {@link buildVeluxCandidates}. */
export interface BuildVeluxCandidatesInput {
  readonly integrationId: string
  readonly integrationName: string
  /** Whether the gateway session is up (drives the gateway candidate's status). */
  readonly online: boolean
  readonly nodes: readonly VeluxNode[]
  /** Native id → adopted CamStack device id, for the top-level devices already adopted. */
  readonly adopted: ReadonlyMap<string, number>
}

function nodeName(input: BuildVeluxCandidatesInput, node: VeluxNode): string {
  return node.name.length > 0
    ? node.name
    : `${input.integrationName} — ${node.coverClass} ${node.nodeId}`
}

function windowCandidate(
  input: BuildVeluxCandidatesInput,
  node: VeluxNode,
  adoptedId: number | null,
): DiscoveredChildDevice {
  const name = nodeName(input, node)
  const status = node.online ? 'online' : 'offline'
  const metadata = {
    manufacturer: 'Velux',
    model: node.coverClass,
    ...(node.serial.length > 0 ? { serialNumber: node.serial } : {}),
  }
  return {
    childNativeId: nodeNativeId(input.integrationId, node),
    name,
    type: DeviceType.Container,
    status,
    metadata,
    alreadyAdopted: adoptedId !== null,
    adoptedDeviceId: adoptedId,
    capabilities: [],
    children: [
      {
        childNativeId: windowCoverNativeId(input.integrationId, node),
        name,
        type: DeviceType.Cover,
        status,
        metadata,
        alreadyAdopted: false,
        adoptedDeviceId: null,
        capabilities: [coverCapability.name],
      },
      {
        childNativeId: rainNativeId(input.integrationId, node),
        name: `${name} rain`,
        type: DeviceType.Sensor,
        status,
        metadata: { manufacturer: 'Velux', model: 'rain sensor' },
        alreadyAdopted: false,
        adoptedDeviceId: null,
        capabilities: [floodCapability.name],
      },
    ],
  }
}

/**
 * The adoption candidates of one integration, pure and in a fixed order:
 * the gateway box ({@link DeviceType.Gateway}), then per actuator node either a
 * {@link DeviceType.Container} (a window with a rain sensor: cover + rain
 * sensor) or a plain {@link DeviceType.Cover}.
 */
export function buildVeluxCandidates(
  input: BuildVeluxCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const gatewayId = gatewayNativeId(input.integrationId)
  const gatewayAdopted = input.adopted.get(gatewayId) ?? null
  const out: DiscoveredChildDevice[] = [
    {
      childNativeId: gatewayId,
      name: input.integrationName,
      type: DeviceType.Gateway,
      status: input.online ? 'online' : 'offline',
      metadata: { manufacturer: 'Velux', model: 'KLF-200' },
      alreadyAdopted: gatewayAdopted !== null,
      adoptedDeviceId: gatewayAdopted,
      // Only what the gateway really supports: the firmware cannot be updated over this API.
      capabilities: [rebootCapability.name, deviceAdminLinkCapability.name],
    },
  ]
  for (const node of input.nodes) {
    const adoptedId = input.adopted.get(nodeNativeId(input.integrationId, node)) ?? null
    if (node.rainSensor) {
      out.push(windowCandidate(input, node, adoptedId))
      continue
    }
    out.push({
      childNativeId: nodeNativeId(input.integrationId, node),
      name: nodeName(input, node),
      type: DeviceType.Cover,
      status: node.online ? 'online' : 'offline',
      metadata: {
        manufacturer: 'Velux',
        model: node.coverClass,
        ...(node.serial.length > 0 ? { serialNumber: node.serial } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [coverCapability.name],
    })
  }
  return out
}
