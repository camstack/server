/**
 * pipeline-analytics' `device-removal-hook` (D865): a deleted device's events,
 * event media, tracks, faces/plates reads and linked-sensor events are removed
 * with it, instead of waiting for retention.
 *
 * It reuses the deletion paths the operator already has — `deleteDeviceEvents`
 * (motion + object + audio events and their media, audited as a prune with
 * reason `orphaned-device`) and `wipeAllAnalytics` (the whole-track cascade,
 * parked-object registries included). Enrolled galleries (identities, vehicles)
 * and the retrain dataset are NOT device data and stay: the cascade exempts the
 * former, and nothing here touches the latter.
 */
import type {
  DeviceDataEntry,
  DeviceRemovedInput,
  DeviceRemovedResult,
  EventPruneCounts,
  IDeviceRemovalHookProvider,
  IScopedLogger,
  TrackCascadeCounts,
} from '@camstack/types'

export interface AnalyticsRemovalDeps {
  readonly logger: IScopedLogger
  readonly deleteDeviceEvents: (input: {
    deviceId: number
    reason: 'orphaned-device'
  }) => Promise<EventPruneCounts>
  readonly wipeAllAnalytics: (input: { deviceId: number }) => Promise<TrackCascadeCounts>
  /** Drop every linked-sensor event of the camera. */
  readonly evictSensorEvents: (deviceId: number, cutoffMs: number) => Promise<number>
  /** Events per device; throws when it could not be read. */
  readonly eventCountsByDevice: () => Promise<ReadonlyMap<number, number>>
  /** Distinct devices with a persisted track. */
  readonly trackDeviceIds: () => Promise<readonly number[]>
  /**
   * The notification centre's device rows (liveness, alerts, system state,
   * snooze counters, occupancy, groups, artifact index — D871). Counts per
   * store; throws when a collection could not be cleaned.
   */
  readonly removeNotificationRows: (deviceId: number) => Promise<Record<string, number>>
  /** The notification centre's per-device rows, per store. */
  readonly listNotificationData: () => Promise<readonly DeviceDataEntry[]>
}

export function createAnalyticsRemovalHook(deps: AnalyticsRemovalDeps): IDeviceRemovalHookProvider {
  return {
    onDeviceRemoved: async (input: DeviceRemovedInput): Promise<DeviceRemovedResult> => {
      const { deviceId } = input
      const events = await deps.deleteDeviceEvents({ deviceId, reason: 'orphaned-device' })
      const tracks = await deps.wipeAllAnalytics({ deviceId })
      const sensor = await deps.evictSensorEvents(deviceId, Number.MAX_SAFE_INTEGER)
      const notification = await deps.removeNotificationRows(deviceId)
      const counts = {
        ...notification,
        events: events.motion + events.object + events.audio,
        tracks: tracks.tracks,
        'track-events': tracks.events,
        media: tracks.media,
        faces: tracks.faces,
        plates: tracks.plates,
        embeddings: tracks.embeddings,
        'sensor-events': sensor,
      }
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
      if (total > 0) {
        deps.logger.info('pipeline-analytics: removed the data of a deleted device', {
          tags: { deviceId },
          meta: { counts, deletedAt: input.deletedAt },
        })
      }
      return { counts }
    },
    listDeviceData: async (): Promise<readonly DeviceDataEntry[]> => {
      const out: DeviceDataEntry[] = []
      for (const [deviceId, count] of await deps.eventCountsByDevice()) {
        if (count > 0 && Number.isInteger(deviceId) && deviceId > 0) {
          out.push({ store: 'events', deviceId, count })
        }
      }
      for (const deviceId of await deps.trackDeviceIds()) {
        if (Number.isInteger(deviceId) && deviceId > 0) {
          out.push({ store: 'tracks', deviceId, count: 1 })
        }
      }
      for (const entry of await deps.listNotificationData()) {
        out.push({ ...entry, store: `notification-${entry.store}` })
      }
      return out
    },
  }
}
