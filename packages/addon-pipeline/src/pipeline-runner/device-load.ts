/**
 * Per-device live load for `RunnerLocalLoad.devices` (multi-device C4).
 *
 * Groups this runner's attached cameras by their assigned inference `deviceKey`
 * so the orchestrator's second `balance()` pass (over a node's devices) sees
 * REAL per-pool session counts — including standing/always-on attaches, which
 * the orchestrator's ephemeral session registry alone would miss (audit F6).
 *
 * A camera with no `deviceKey` (default pool / pre-multi-device session) is not
 * attributed to any device. There is no per-device queue depth: the
 * inference-pool backlog has no accessor, and a field that always read 0 was
 * removed rather than reported as a measurement (D762). The session count is
 * the load signal the device balancer weights on — mirroring the node tier's
 * `attachedCameras`.
 */
export interface DeviceLoadEntry {
  readonly deviceKey: string
  readonly backend: string
  readonly attachedCameras: number
}

/** The backend prefix of a `<backend>:<device>` key (bare `cpu` → `cpu`). */
function backendOf(deviceKey: string): string {
  const colon = deviceKey.indexOf(':')
  return colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
}

export function summarizeDeviceLoad(
  attachedDeviceKeys: Iterable<string | undefined>,
): DeviceLoadEntry[] {
  const counts = new Map<string, number>()
  for (const key of attachedDeviceKeys) {
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([deviceKey, attachedCameras]) => ({
      deviceKey,
      backend: backendOf(deviceKey),
      attachedCameras,
    }))
    .toSorted((a, b) => a.deviceKey.localeCompare(b.deviceKey))
}
