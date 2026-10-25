/**
 * DeviceContext — current device id (and optional cached device
 * snapshot) for the page subtree.
 *
 * Provided by host pages (admin-ui DeviceDetail, addon device pages)
 * so that deeply-nested form/field renderers can resolve the device
 * they're acting on without prop drilling. Used by custom field
 * renderers (`zone-editor` → polygon canvas, `device-info` /
 * `live-stream-viewer` / `pipeline-stats` / `doorbell-recent` /
 * `stream-network-stats` → overview blocks) that need to call
 * device-scoped caps or read the device's static metadata.
 *
 * The `device` snapshot is optional — when the host has already
 * fetched the device (DeviceDetail loads it on mount) the renderer
 * can read static fields (name, type, addonId, features, stableId)
 * directly from context instead of round-tripping `deviceManager.get`.
 * Adapters that need it MUST also tolerate `null` so they can be
 * mounted in subtrees that don't carry the snapshot — they fall back
 * to their own query in that case.
 */
import { useContext, type ReactNode, type JSX } from 'react'
import { createSharedContext } from '../lib/shared-context'

/**
 * Cached device snapshot. Loose-typed (`Record<string, unknown>`) at
 * the boundary because the wire shape lives in different places
 * depending on the caller — DeviceDetail reads from
 * `deviceManager.list`, `addon-admin-ui` from a hand-loaded subset.
 * Renderers narrow the fields they actually need.
 */
export type DeviceSnapshot = Readonly<Record<string, unknown>>

interface DeviceContextValue {
  readonly deviceId: number
  readonly device: DeviceSnapshot | null
}

const DeviceContext = createSharedContext<DeviceContextValue | null>(
  'camstack:device-context',
  null,
)

export interface DeviceContextProviderProps {
  readonly deviceId: number
  /** Optional cached device snapshot — readers narrow the fields they need. */
  readonly device?: DeviceSnapshot
  readonly children: ReactNode
}

export function DeviceContextProvider({
  deviceId,
  device,
  children,
}: DeviceContextProviderProps): JSX.Element {
  const value: DeviceContextValue = { deviceId, device: device ?? null }
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
}

/** @returns the device id of the current page subtree, or null if outside any provider. */
export function useDeviceId(): number | null {
  return useContext(DeviceContext)?.deviceId ?? null
}

/** @returns the cached device snapshot, or null when no snapshot is provided. */
export function useDeviceSnapshot(): DeviceSnapshot | null {
  return useContext(DeviceContext)?.device ?? null
}
