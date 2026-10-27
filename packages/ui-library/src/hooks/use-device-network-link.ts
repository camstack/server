/**
 * useDeviceNetworkLink — the device's own network link (medium + signal).
 *
 * Same shape as `useDeviceBattery`: a thin wrapper over `useDeviceState`,
 * fed by the kernel runtime-state mirror (one fetch on first subscribe, then
 * push updates on every `network-link` slice write). Returns `null` when no
 * provider has emitted yet — a device without the cap simply has no badge.
 */
import { useDeviceState, type UseDeviceProxyTrpc } from './use-device-proxy'

export interface NetworkLinkStatus {
  readonly type: 'wifi' | 'ethernet' | 'cellular' | 'unknown'
  /** `null` = not known or not applicable (a wired link has no signal). */
  readonly signal: number | null
  readonly rssi?: number
  readonly ssid?: string
  readonly lastUpdated: number
}

export function useDeviceNetworkLink(
  trpc: UseDeviceProxyTrpc,
  deviceId: number | null,
): NetworkLinkStatus | null {
  const slice = useDeviceState(trpc, deviceId, (s) => s.networkLink)
  return (slice as NetworkLinkStatus | undefined) ?? null
}
