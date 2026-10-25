/**
 * The ONE cast-free narrowing of the `device.state-changed` payload. The
 * category is not part of the typed `EventCatalog` — every subscriber validates
 * at the boundary, and the builtins share this one narrowing instead of a
 * verbatim copy each (D659), like `./settle-sources.ts`; addons never import
 * each other, and its consumers live in this package.
 */

/** Narrowed payload of a `DeviceStateChanged` bus event. */
export interface DeviceStateChangedData {
  readonly deviceId: number
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
}

/** Structural narrowing helper for untrusted bus payloads. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDeviceStateChanged(data: unknown): DeviceStateChangedData | null {
  if (!isRecord(data)) return null
  const deviceId = data['deviceId']
  const capName = data['capName']
  const slice = data['slice']
  if (typeof deviceId !== 'number' || typeof capName !== 'string') return null
  if (!isRecord(slice)) return null
  return { deviceId, capName, slice }
}
