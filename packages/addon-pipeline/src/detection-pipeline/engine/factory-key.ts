/** Sentinel key for the provider's default (node-current-engine) factory. */
export const DEFAULT_DEVICE_KEY = '__default__'

/**
 * Normalise an optional per-call `deviceKey` to a factory-map key. An omitted
 * or empty key routes to the default factory (current single-engine behaviour).
 */
export function pickFactoryKey(deviceKey: string | undefined): string {
  return deviceKey !== undefined && deviceKey.length > 0 ? deviceKey : DEFAULT_DEVICE_KEY
}
