/**
 * What the Customize tab needs to know about the device, each fact a
 * `Known<…>` (D315): what the type CAN be given (`listComposableCaps`), what it
 * serves itself (`getBindings`, the validator's own native rule), its fields
 * (`getWireableFields`), and what the customization already composes.
 */
import type { Composition, DeviceInfo } from '@camstack/types'
import {
  useCoreBlocksListComposableCaps,
  useDeviceManagerGetBindings,
  useDeviceManagerGetWireableFields,
} from '@camstack/ui-library'
import { nativeCapNames } from './assignment-availability'
import { type CustomizeFacts, knownOf } from './customize-facts'

export function useCustomizeFacts(
  device: DeviceInfo,
  composition: Composition | null,
): CustomizeFacts {
  const composableQuery = useCoreBlocksListComposableCaps({ deviceType: device.type })
  const bindingsQuery = useDeviceManagerGetBindings({ deviceId: device.id })
  const wireableQuery = useDeviceManagerGetWireableFields({ deviceId: device.id })
  const composable = knownOf(composableQuery, (d) => new Set(d.caps.map((c) => c.cap)))
  const nativeCaps = knownOf(bindingsQuery, (d) => nativeCapNames(d.entries))
  const wireable = knownOf(wireableQuery, (d) => d)
  return {
    deviceType: device.type,
    composable,
    nativeCaps,
    wireable,
    composed: new Set((composition?.features ?? []).map((f) => f.cap)),
  }
}
