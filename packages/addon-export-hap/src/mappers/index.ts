/**
 * Mapper registry — picks the concrete orchestrator for a camstack device.
 *
 * Two kinds, and the split is by ACCESSORY SHAPE, not by feature:
 *
 *  - `camera` — the streaming accessory. One orchestrator inspects the device's
 *    capability binding and adds streams, HKSV recording, doorbell, motion,
 *    intercom, PTZ, battery, privacy and every accessory child as services on
 *    ONE accessory. See `camera-accessory.ts`.
 *  - `generic` — every other device. A capability→service TABLE decides what it
 *    publishes; there is no per-type branch anywhere in that path. See
 *    `generic-accessory.ts` and `builders/generic/cap-service-table.ts`.
 *
 * `pickMapperKind`, the supported device types and the accessory uuid
 * convention live in `kind.ts` so the orchestrators can share them without
 * importing this registry.
 */
import type { AddonContext } from '@camstack/types'

import { buildCameraAccessory } from './camera-accessory.js'
import { buildGenericAccessory } from './generic-accessory.js'
import type { MapperKind } from './kind.js'
import type { CameraMapperOptions, Mapper } from './types.js'

export interface MapperFactoryInput {
  readonly ctx: AddonContext
  readonly deviceId: string
  readonly displayName: string
  readonly options: CameraMapperOptions
}

export type MapperFactory = (input: MapperFactoryInput) => Promise<Mapper>

const REGISTRY: Readonly<Record<MapperKind, MapperFactory>> = {
  camera: buildCameraAccessory,
  generic: buildGenericAccessory,
}

export function getMapperFactory(kind: MapperKind): MapperFactory {
  const factory = REGISTRY[kind]
  if (!factory) {
    throw new Error(`export-hap: no mapper registered for kind '${kind}'`)
  }
  return factory
}

export {
  accessoryUuidFor,
  HAP_EXPORTABLE_DEVICE_TYPES,
  type MapperKind,
  pickMapperKind,
  SUPPORTED_MAPPER_KINDS,
} from './kind.js'
export type { CameraMapperOptions, Mapper } from './types.js'
