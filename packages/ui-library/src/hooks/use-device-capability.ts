/**
 * useDeviceCapability — accessor-based readiness wrapper around
 * `useDeviceProxy` + `useDeviceStateSlice`. Combines the three
 * preconditions a UI quick-action needs in one call:
 *
 *   1. Device proxy resolved (bindings landed)
 *   2. Cap handle present on the proxy (i.e. cap is bound)
 *   3. Slice has arrived (provider has published its first snapshot)
 *
 * Optional fourth precondition: a `DeviceFeature` flag advertised on
 * the device row. Useful for surfaces that only render a control when
 * the feature is declared (e.g. the on-motion toggle on a switch).
 *
 * Caller passes typed accessor callbacks so the cap + slice types
 * carry through TypeScript without casts:
 *
 *   const { dev, cap, slice, available } = useDeviceCapability({
 *     trpc, deviceId,
 *     cap:   (dev) => dev.switch,
 *     slice: (dev) => dev.state.switch,
 *     requireFeature: 'switch',          // optional
 *     deviceFeatures: device.features,   // optional, only if feature gate used
 *   })
 *   if (available) await cap.setState({ on: !slice.on })
 */
import type { DeviceProxy, DeviceStatus, SliceHandle } from '@camstack/types'
import { useDeviceProxy, useDeviceStateSlice, type UseDeviceProxyTrpc } from './use-device-proxy'

export interface UseDeviceCapabilityOptions<TCap, TSlice> {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number | null
  readonly cap: (dev: DeviceProxy) => TCap | undefined
  readonly slice: (dev: DeviceProxy) => SliceHandle<TSlice> | undefined
  readonly requireFeature?: string
  readonly deviceFeatures?: readonly string[]
}

export interface UseDeviceCapabilityResult<TCap, TSlice> {
  readonly dev: DeviceProxy | null
  readonly cap: TCap | undefined
  readonly slice: TSlice | undefined
  readonly available: boolean
  /**
   * Resolved device liveness from the auto-registered `device-status`
   * cap slice. Defaults to `true` until the slice lands so initial load
   * never false-disables a control. Drives `available` (offline = no
   * control).
   */
  readonly online: boolean
  /**
   * Ms epoch of the last `online` transition when the device is
   * currently offline, else `null`. Lets a badge render "offline since".
   */
  readonly offlineSince: number | null
}

export function useDeviceCapability<TCap, TSlice>(
  options: UseDeviceCapabilityOptions<TCap, TSlice>,
): UseDeviceCapabilityResult<TCap, TSlice> {
  const dev = useDeviceProxy(options.trpc, options.deviceId)
  const sliceHandle = dev !== null ? options.slice(dev) : undefined
  const slice = useDeviceStateSlice<TSlice>(sliceHandle)
  const cap = dev !== null ? options.cap(dev) : undefined

  // Device liveness from the auto-registered `device-status` cap — the
  // single source of truth (`BaseDevice.online`) every provider mirrors.
  const statusHandle = dev !== null ? dev.state.deviceStatus : undefined
  const statusSlice = useDeviceStateSlice<DeviceStatus>(statusHandle)
  // Default ONLINE when the slice hasn't landed yet — never false-disable
  // during initial load; only an explicit `online: false` gates controls.
  const online = statusSlice?.online ?? true
  const offlineSince = online ? null : (statusSlice?.lastChangedAt ?? null)

  const featureOk =
    options.requireFeature === undefined ||
    (options.deviceFeatures ?? []).includes(options.requireFeature)
  const capPresent = cap !== undefined
  const sliceLanded = slice !== undefined
  const available = featureOk && capPresent && sliceLanded && online

  return { dev, cap, slice, available, online, offlineSince }
}
