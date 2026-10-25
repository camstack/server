import {
  DeviceType,
  type DiscoveredChildDevice,
  type DiscoveredChildStatus,
  type SourceInfo,
} from '@camstack/types'
import { inferParentDeviceType } from './ha-domain-mapping.js'
import type { HaDiscoveredDevice } from './ha-discovery-types.js'

/**
 * Map an `HaDiscoveredDevice` (the HA addon's HA-shaped discovery
 * candidate) onto the shared `DiscoveredChildDevice` the generic
 * `device-adoption` cap surfaces. The HA device becomes the parent
 * candidate; each HA entity becomes a nested child candidate.
 *
 * `mappedTo.deviceType` is already a `DeviceType` enum value, so no cast
 * is needed — entities without a mapping fall back to `DeviceType.Generic`.
 */
export function haDeviceToCandidate(dev: HaDiscoveredDevice): DiscoveredChildDevice {
  const children: DiscoveredChildDevice[] = dev.entities.map((e) => {
    // sourceInfo = identity only. unitOfMeasurement and deviceClass are
    // boundary inputs for ha-domain-mapping → role, and are NOT stored on
    // sourceInfo after that point (unit flows live via the cap slice).
    const sourceInfo: SourceInfo = {
      id: e.entityId,
      system: 'homeassistant',
    }
    return {
      childNativeId: e.entityId,
      name: e.name,
      type: e.mappedTo?.deviceType ?? DeviceType.Generic,
      status: entityStatus(e.state),
      metadata: e.area !== null ? { externalLocation: e.area } : {},
      alreadyAdopted: e.alreadyAdopted,
      adoptedDeviceId: e.adoptedCamDeviceId,
      capabilities: e.mappedTo ? [...e.mappedTo.capabilities] : [],
      sourceInfo,
    }
  })

  // Parent type mirrors the adoption flow's heuristic so a discovered
  // candidate's type matches the parent that materialises on adopt.
  const parentType = inferParentDeviceType(dev.entities.map((e) => e.mappedTo))
  // Parent reachability is derived from its children: online if any child
  // is reachable, otherwise unknown.
  const parentStatus: DiscoveredChildStatus = children.some((c) => c.status === 'online')
    ? 'online'
    : 'unknown'
  const parentSource: SourceInfo = { id: dev.haDeviceId, system: 'homeassistant' }
  return {
    childNativeId: dev.haDeviceId,
    name: dev.name,
    type: parentType,
    status: parentStatus,
    metadata: {
      ...(dev.model !== null ? { model: dev.model } : {}),
      ...(dev.manufacturer !== null ? { manufacturer: dev.manufacturer } : {}),
      ...(dev.integration !== null ? { integration: dev.integration } : {}),
      ...(dev.area !== null ? { externalLocation: dev.area } : {}),
    },
    alreadyAdopted: dev.alreadyAdopted,
    adoptedDeviceId: dev.adoptedCamDeviceId,
    capabilities: [],
    sourceInfo: parentSource,
    children,
  }
}

/** Derive child reachability from the HA entity `state` (not adoption). */
function entityStatus(state: string): DiscoveredChildStatus {
  if (state === 'unavailable') return 'offline'
  if (state === '' || state === 'unknown') return 'unknown'
  return 'online'
}
