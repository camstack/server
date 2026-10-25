/**
 * Fleet disk-wins reconcile — one operator action walks every camera:
 * recordings index is reseated from the walk, then analytics ghosts are
 * dropped. Failures are isolated per camera so one bad device cannot abort
 * the fleet.
 */
export interface FleetDiskReconcileCameraCounts {
  readonly mediaDropped: number
  readonly tracks: number
  readonly events: number
}

export interface FleetDiskReconcileProgress {
  readonly deviceId: number
  readonly total: number
  readonly completed: number
  readonly failed: readonly number[]
  readonly mediaDropped: number
  readonly tracks: number
  readonly events: number
}

export interface FleetDiskReconcileDeps {
  listDeviceIds(): Promise<readonly number[]>
  rescanRecordings(deviceId: number): Promise<void>
  reconcileAnalytics(deviceId: number): Promise<FleetDiskReconcileCameraCounts>
  onProgress?(update: FleetDiskReconcileProgress): void
}

export interface FleetDiskReconcileResult {
  readonly cameras: number
  readonly failed: readonly number[]
  readonly mediaDropped: number
  readonly tracks: number
  readonly events: number
}

export async function reconcileFleetFromDisk(
  deps: FleetDiskReconcileDeps,
): Promise<FleetDiskReconcileResult> {
  const deviceIds = await deps.listDeviceIds()
  const failed: number[] = []
  let cameras = 0
  let mediaDropped = 0
  let tracks = 0
  let events = 0
  let completed = 0
  for (const deviceId of deviceIds) {
    try {
      await deps.rescanRecordings(deviceId)
      const counts = await deps.reconcileAnalytics(deviceId)
      cameras += 1
      mediaDropped += counts.mediaDropped
      tracks += counts.tracks
      events += counts.events
    } catch {
      failed.push(deviceId)
    }
    completed += 1
    deps.onProgress?.({
      deviceId,
      total: deviceIds.length,
      completed,
      failed: [...failed],
      mediaDropped,
      tracks,
      events,
    })
  }
  return { cameras, failed, mediaDropped, tracks, events }
}
