/**
 * The secret config paths each device DECLARES (D783) — `connection.password`,
 * `localKey`, `rows[].token` — as its runner last reported them at
 * `registerDevice`.
 *
 * In memory on purpose: a runner re-registers every device it owns whenever it
 * (re)starts, and a hub-main restart restarts every runner, so the map refills
 * on its own. Until a device has registered, its `DeviceInfo` carries no paths
 * and the non-admin redaction falls back to its keyword backstop — never to
 * "no redaction". Paths only; never a value.
 */
export interface SecretConfigPathRegistry {
  /** The paths last reported for `deviceId`, or `undefined` when none were. */
  get(deviceId: number): readonly string[] | undefined
  /** Replace the paths for `deviceId` with the runner's latest report. */
  set(deviceId: number, paths: readonly string[]): void
  /** Forget a removed device. */
  delete(deviceId: number): void
}

export function createSecretConfigPathRegistry(): SecretConfigPathRegistry {
  const byDevice = new Map<number, readonly string[]>()
  return {
    get: (deviceId) => byDevice.get(deviceId),
    set: (deviceId, paths) => {
      byDevice.set(deviceId, Object.freeze([...new Set(paths)]))
    },
    delete: (deviceId) => {
      byDevice.delete(deviceId)
    },
  }
}

/** `{ secretConfigPaths }` when any are known, `{}` otherwise — spread into a `DeviceInfo`. */
export function secretConfigPathsField(paths: readonly string[] | undefined): {
  secretConfigPaths?: string[]
} {
  return paths !== undefined && paths.length > 0 ? { secretConfigPaths: [...paths] } : {}
}
