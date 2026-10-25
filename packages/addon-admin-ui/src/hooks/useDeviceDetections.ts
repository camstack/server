/**
 * useDeviceDetections — admin-ui wrapper around the shared ui-library hook.
 *
 * Passes the unified `System.trpcClient` to the parametrized hook.
 * Re-exports all types so existing admin-ui consumers don't need to change imports.
 */
import {
  useSystem,
  useDeviceDetections as useDeviceDetectionsBase,
  type DeviceDetections,
  type MotionState,
  type MotionZone,
  type MotionRawState,
  type MotionRawBox,
  type DetectionState,
} from '@camstack/ui-library'

export type {
  DeviceDetections,
  MotionState,
  MotionZone,
  MotionRawState,
  MotionRawBox,
  DetectionState,
}

export function useDeviceDetections(deviceId: number | null): DeviceDetections {
  const system = useSystem()
  return useDeviceDetectionsBase(system.trpcClient, deviceId)
}
