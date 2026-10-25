/**
 * The PERMANENT per-camera notification mute.
 *
 * It began as the `notifications` member of the per-camera function switch
 * group ([D62](../../../../docs/decisions/adr-0062.md)). That group is gone
 * ([D113](../../../../docs/decisions/adr-0113.md)); the AUTHORITY did not move.
 * These rows are still the one true answer to "does this device notify", and
 * they are now read and written by the notification centre's own per-device
 * panel (`DeviceNotificationMute`, admin-ui) through
 * `notificationRules.listDeviceMutes` / `setDeviceMuted` — plus the alarm's
 * coverage accounting, which reports a muted device as
 * `skippedDevices: 'muted'`.
 *
 * This is the ONE switch in that group that needed new state, because nothing
 * in the notification centre could express "this camera never notifies":
 *
 *  - a **snooze** is bounded at `NC_SNOOZE_MAX_MINUTES` (24h) deliberately —
 *    "a snooze that could not expire would be an outage the operator asked for
 *    once and forgot". Widening it to carry an indefinite silence would remove
 *    that property from every snooze;
 *  - `rule.conditions.devices` is a per-RULE allow-list — muting one camera
 *    that way means editing every rule, and re-enabling means remembering
 *    which ones you touched;
 *  - `rule.disabledTargetIds` and a target's `enabled` are per-recipient.
 *
 * So: one per-device setting per muted camera (key `notificationMuted`, D870),
 * admin-only, indefinite, and REPORTED as off on `CameraStatus.switchedOff`. An indefinite silence that nothing surfaces is
 * the notification centre that had never delivered anything; this one is
 * visible on the device's own Notifications panel and on the camera's status.
 */
import type { IScopedLogger } from '@camstack/types'

/** The per-device settings key a muted camera carries. Absent IS not-muted. */
export const NOTIFICATION_MUTED_KEY = 'notificationMuted'

/** The slice of `ctx.settings` the mute store persists through. */
export interface NcDeviceMuteSettings {
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

export interface NcDeviceMuteStoreDeps {
  readonly settings: NcDeviceMuteSettings
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/**
 * Absence of a setting is "not muted"; there is no `muted: false` value. That
 * keeps the store proportional to what the operator actually silenced, makes the
 * hot-path read a `Set.has`, and lets the central device delete (D865) take the
 * mute with the device without a handler.
 */
export class NcDeviceMuteStore {
  private readonly muted = new Set<number>()
  private readonly settings: NcDeviceMuteSettings
  private readonly logger: IScopedLogger
  private readonly now: () => number

  constructor(deps: NcDeviceMuteStoreDeps) {
    this.settings = deps.settings
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * (Re)hydrate. A failed load KEEPS what is already in memory rather than
   * clearing it: dropping every mute on a transient store error would start
   * notifying for a camera the operator silenced, without them asking — the
   * same reasoning as `NcSnoozeStore.load`.
   */
  async load(): Promise<void> {
    try {
      const ids = await this.settings.listDeviceStoreIds()
      const blobs = await this.settings.readDeviceStoreBatch(ids)
      const next = new Set<number>()
      for (const [deviceId, blob] of blobs) {
        if (blob[NOTIFICATION_MUTED_KEY] !== undefined) next.add(deviceId)
      }
      this.muted.clear()
      for (const id of next) this.muted.add(id)
    } catch (err) {
      this.logger.warn('device-mute load failed — keeping the mutes already in memory', {
        meta: { error: String(err), muted: this.muted.size },
      })
    }
  }

  /** Hot-path read, called once per evaluated subject. */
  isMuted(deviceId: number): boolean {
    return this.muted.has(deviceId)
  }

  /** Every muted camera, ascending — a stable order so two callers agree. */
  listMuted(): readonly number[] {
    return [...this.muted].toSorted((a, b) => a - b)
  }

  /**
   * Mute or unmute. Idempotent in both directions; the in-memory set is
   * updated only after the write lands, so a failed write cannot leave the
   * hot path believing a camera is silenced when the next boot will not.
   */
  async setMuted(deviceId: number, muted: boolean): Promise<void> {
    if (muted) {
      await this.settings.writeDeviceStore(deviceId, {
        [NOTIFICATION_MUTED_KEY]: { mutedAt: this.now() },
      })
      this.muted.add(deviceId)
    } else {
      await this.settings.writeDeviceStore(deviceId, { [NOTIFICATION_MUTED_KEY]: undefined })
      this.muted.delete(deviceId)
    }
  }
}
