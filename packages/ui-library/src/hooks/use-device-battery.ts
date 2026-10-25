/**
 * useDeviceBattery — battery status for a device.
 *
 * Thin wrapper over the `useDeviceState` combinator, which itself
 * wraps `useDeviceProxy + useDeviceStateSlice(dev?.state.battery)`.
 * The kernel runtime-state mirror keeps the slice value warm — one
 * initial fetch on first subscribe, then push updates on every
 * `setCapSlice` for the battery slice. No manual event subscription,
 * no parallel `getStatus` polling.
 *
 * Returns `null` when no provider has emitted yet (non-battery
 * camera, or initial fetch hasn't returned).
 */
import type { BatteryStatus } from '@camstack/types'
import { type UseDeviceProxyTrpc, useDeviceState } from './use-device-proxy'

/**
 * The cap's own runtime-state shape (`z.infer<BatteryStatusSchema>`) —
 * `percentage` is `number | null`: `null` means no reading has landed yet
 * (D315). Re-exported so call sites don't have to reach into
 * `@camstack/types` themselves.
 */
export type { BatteryStatus }

/**
 * Backwards-compatible alias for the trpc shape — historically the
 * hook took its own narrow contract; the proxy generalisation
 * supersedes that.
 */
export type UseDeviceBatteryTrpc = UseDeviceProxyTrpc

export function useDeviceBattery(
  trpc: UseDeviceProxyTrpc,
  deviceId: number | null,
): BatteryStatus | null {
  const slice = useDeviceState(trpc, deviceId, (s) => s.battery)
  return slice ?? null
}
