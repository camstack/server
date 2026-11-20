import type { CcuDeviceRow } from '../ccu/ccu-schemas.js'

/** The query param that holds the open device's CCU address (the page already owns `?tab=` and `?ccu=`). */
export const DEVICE_PARAM = 'device'

/**
 * Where a device's detail lives: the page's own route, the Devices tab, the
 * address in `?device=`. The host's `navigate` resolves the basename.
 */
export function deviceDetailPath(address: string, integrationId: string | null = null): string {
  const params = new URLSearchParams()
  if (integrationId !== null && integrationId !== '') params.set('ccu', integrationId)
  params.set('tab', 'devices')
  params.set(DEVICE_PARAM, address)
  return `/addon/homematic-ccu?${params.toString()}` // hub-path-ok: AddonPageProps.navigate, basename-aware
}

/** What `?device=` means once the device list has (or has not) answered. */
export type DeviceSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly address: string }
  | { readonly kind: 'found'; readonly device: CcuDeviceRow }
  | { readonly kind: 'missing'; readonly address: string }

/**
 * The URL ↔ selected device mapping. An absent param is the table; a param
 * while the list is still unanswered is pending (never "not found"); a param
 * whose address the answered list lacks is missing, named.
 */
export function resolveDeviceSelection(
  param: string | null,
  devices: readonly CcuDeviceRow[] | undefined,
): DeviceSelection {
  if (param === null || param === '') return { kind: 'none' }
  if (devices === undefined) return { kind: 'pending', address: param }
  const device = devices.find((row) => row.address === param)
  return device === undefined ? { kind: 'missing', address: param } : { kind: 'found', device }
}

/**
 * The radio interface a device pairs on, from its type prefix (the CCU's
 * descriptor carries no interface name): HmIP wireless, HmIP wired, BidCos
 * wired (HMW), otherwise BidCos-RF.
 */
export function ccuInterfaceOf(type: string): string {
  const upper = type.toUpperCase()
  if (upper.startsWith('HMIPW')) return 'HmIP-Wired'
  if (upper.startsWith('HMIP')) return 'HmIP-RF'
  if (upper.startsWith('HMW')) return 'BidCos-Wired'
  return 'BidCos-RF'
}

/** Whether a CCU address (device or `device:channel`) belongs to the device. */
export function belongsToDevice(address: string | null, deviceAddress: string): boolean {
  return address !== null && (address === deviceAddress || address.startsWith(`${deviceAddress}:`))
}

/**
 * The admin device page. Same path as `devicePath` in addon-admin-ui
 * (`lib/customization-routes.ts`); the host's `navigate` resolves the basename.
 */
export function camstackDevicePagePath(deviceId: number): string {
  return `/devices/${deviceId}` // hub-path-ok: AddonPageProps.navigate, basename-aware
}
