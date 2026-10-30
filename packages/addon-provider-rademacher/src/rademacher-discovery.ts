import {
  coverCapability,
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
} from '@camstack/types'

const GATEWAY_SUFFIX = ':gateway'
const COVER_INFIX = ':cover:'

/**
 * Minimal structural subset of a noderademacher cover handle the adoption code
 * needs. Structurally compatible with the real handle and test fixtures.
 */
export interface AdoptableCover {
  readonly did: string
  readonly name: string
  readonly model: string
  readonly online: boolean
  readonly supportsPosition: boolean
  readonly supportsTilt: boolean
}

/** The `childNativeId` of the hub box itself, one per integration. */
export function gatewayNativeId(integrationId: string): string {
  return `${integrationId}${GATEWAY_SUFFIX}`
}

/**
 * The `childNativeId` of a cover candidate. HomePilot's `did` is stable across
 * reboots; it is namespaced under the integration so two hubs never collide.
 */
export function coverNativeId(integrationId: string, did: string): string {
  return `${integrationId}${COVER_INFIX}${did}`
}

/** What a native id points at on the integration. */
export type ResolvedNativeId =
  | { readonly kind: 'gateway' }
  | { readonly kind: 'cover'; readonly cover: AdoptableCover }

/** Resolve an adoptable native id against the integration's current covers, or null when none matches. */
export function resolveNativeId(
  integrationId: string,
  covers: readonly AdoptableCover[],
  childNativeId: string,
): ResolvedNativeId | null {
  if (childNativeId === gatewayNativeId(integrationId)) return { kind: 'gateway' }
  for (const cover of covers) {
    if (childNativeId === coverNativeId(integrationId, cover.did)) return { kind: 'cover', cover }
  }
  return null
}

/** Inputs for {@link buildRademacherCandidates}. */
export interface BuildRademacherCandidatesInput {
  readonly integrationId: string
  readonly integrationName: string
  /** Whether the hub session is up (drives the gateway candidate's status). */
  readonly online: boolean
  /** The hub's own model (`HomePilot` / `Start2Smart`) when it reported one. */
  readonly hubModel: string | null
  readonly covers: readonly AdoptableCover[]
  /** Native id → adopted CamStack device id, for the devices already adopted. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * The adoption candidates of one integration, pure and in a fixed order: the hub
 * box ({@link DeviceType.Gateway}), then one {@link DeviceType.Cover} per roller
 * shutter. None is a child of the gateway.
 */
export function buildRademacherCandidates(
  input: BuildRademacherCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const gatewayId = gatewayNativeId(input.integrationId)
  const gatewayAdopted = input.adopted.get(gatewayId) ?? null
  const out: DiscoveredChildDevice[] = [
    {
      childNativeId: gatewayId,
      name: input.integrationName,
      type: DeviceType.Gateway,
      status: input.online ? 'online' : 'offline',
      metadata: { manufacturer: 'Rademacher', model: input.hubModel ?? 'HomePilot' },
      alreadyAdopted: gatewayAdopted !== null,
      adoptedDeviceId: gatewayAdopted,
      // Only what the hub really supports: no reboot, and its library cannot start a firmware update.
      capabilities: [deviceAdminLinkCapability.name],
    },
  ]
  for (const cover of input.covers) {
    const nativeId = coverNativeId(input.integrationId, cover.did)
    const adoptedId = input.adopted.get(nativeId) ?? null
    out.push({
      childNativeId: nativeId,
      name: cover.name.length > 0 ? cover.name : `${input.integrationName} — Cover ${cover.did}`,
      type: DeviceType.Cover,
      status: cover.online ? 'online' : 'offline',
      metadata: {
        manufacturer: 'Rademacher',
        ...(cover.model.length > 0 ? { model: cover.model } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: [coverCapability.name],
      parentStableId: gatewayId,
    })
  }
  return out
}
