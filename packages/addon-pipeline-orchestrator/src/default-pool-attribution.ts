/**
 * Credit a single-device node's default-pool sessions to its one device.
 *
 * The runner counts `RunnerLocalLoad.devices` by each attached camera's
 * `deviceKey`. A camera dispatched with NO `deviceKey` runs on the runner's
 * default pool and is counted against no device. When the node has exactly one
 * eligible device, the balancer leaves `deviceKey` unset on purpose
 * (`single-eligible-device`) and the default pool IS that device — the same
 * equivalence the attach applies to provisioning (D745). So those sessions are
 * that device's sessions, and the report says so.
 *
 * With several eligible devices (a default pool reached through
 * `pin-unplaceable` / `all-devices-at-cap`) which accelerator the default pool
 * used is not known, so nothing is attributed — the UI then reads the device
 * count as unknown, never 0. No `deviceKey` is invented for the runner: this
 * rewrites the REPORT, not the attach.
 */
import type { RunnerLocalLoad } from '@camstack/types'

/** The backend prefix of a `<backend>:<device>` key (bare `cpu` → `cpu`). */
function backendOf(deviceKey: string): string {
  const colon = deviceKey.indexOf(':')
  return colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
}

/**
 * `load` with its unattributed sessions credited to `eligibleKeys[0]` when that
 * is the node's ONLY eligible device; `load` itself (same reference) otherwise.
 * `eligibleKeys` null = the eligible set is not known.
 */
export function attributeDefaultPoolSessions(
  load: RunnerLocalLoad,
  eligibleKeys: readonly string[] | null,
): RunnerLocalLoad {
  if (eligibleKeys === null || eligibleKeys.length !== 1) return load
  const onlyKey = eligibleKeys[0]
  if (onlyKey === undefined) return load
  const attributed = load.devices.reduce((sum, d) => sum + d.attachedCameras, 0)
  const unattributed = load.attachedCameras - attributed
  if (unattributed <= 0) return load

  const existing = load.devices.find((d) => d.deviceKey === onlyKey)
  const credited = existing
    ? { ...existing, attachedCameras: existing.attachedCameras + unattributed }
    : {
        deviceKey: onlyKey,
        backend: backendOf(onlyKey),
        attachedCameras: unattributed,
      }
  const devices = [...load.devices.filter((d) => d.deviceKey !== onlyKey), credited].toSorted(
    (a, b) => a.deviceKey.localeCompare(b.deviceKey),
  )
  return { ...load, devices }
}
