/**
 * What one HomeKit bridge exposes (D985, D996): a `hap-bridge-exports` row per bridge instance,
 * under the instance's own id, holds the devices it mirrors (with their per-device export
 * settings) and the actions it publishes as momentary switches. The identity a controller pairs
 * with is the sibling `hap-bridges` row; this row is what that bridge CARRIES.
 *
 * It replaces the `exposed` and `exposedActions` addon settings. The migration moved them; the
 * addon reads this record and nothing else.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'
import type { ActionExportEntry } from './action-exports.js'
import type { MapperKind } from './mappers/kind.js'

/**
 * Per-device export settings persisted on each `ExposedConfigEntry`.
 * The shape is shared across all three export addons (HAP / Alexa /
 * HA-MQTT); HA-MQTT extends it with addon-specific fields on its own
 * entry type.
 */
export interface ExportDeviceSettings {
  /** Offer Apple's new multi-tier RTP camera service (HEVC / 4K) on this
   *  camera. Absent means ON — see {@link resolveMultiTierService}. */
  readonly multiTierService?: boolean
  /**
   * Preferred broker stream id used when the HomeKit camera service
   * dials the RTSP restream.
   *
   * `'auto'` resolves against the resolution the CONTROLLER negotiated:
   * `pickPreferredRtspEntry` is driven with `request.video.{width,height}`
   * and prefers the smallest profile at or above that target, falling back
   * to the largest below it. Note the consequence — a controller asking for
   * 720p is steered onto whichever slot is bound to `mid`, regardless of the
   * frame rate that slot actually delivers.
   *
   * That steering is now REFLECTED in what we advertise: the frame rate
   * offered for each resolution is the real rate of the slot this same picker
   * resolves it to (measured by the broker, else published by the provider,
   * else assumed). So changing this setting changes the advertisement, which
   * is why a change triggers a full accessory rebuild below.
   * See `mappers/builders/stream-fps.ts`.
   */
  readonly streamPreference: 'auto' | string
  /**
   * Route this device's accessory onto the shared BRIDGE instead of giving it
   * its own mDNS advertisement, HAP server and pairing.
   *
   * Default ON for every non-camera, and absent means ON — the field did not
   * exist for entries persisted before it, and one accessory each is a port, an
   * advertisement, a pairing record and a separate "Add Accessory" per device.
   * Ignored for cameras, which HomeKit forbids bridging; the field is not even
   * offered there (`shouldBridge` is the one place that decides).
   *
   * A change REBUILDS the accessory and DROPS its pairing: a standalone
   * accessory and a bridged one are different identities to iOS, so the device
   * leaves the Home app and is added again from the bridge. The description in
   * the panel says so.
   */
  readonly useBridge?: boolean
  /**
   * Whether we may DECODE AND RE-ENCODE this camera's stream for HomeKit.
   *
   * ON unless the operator says otherwise, and ABSENT means ON — the field did
   * not exist for entries persisted before it. Same switch as Alexa's, and the
   * same meaning: it says what the operator is willing to SPEND, not what they
   * want to see. A transcode is a decode plus an encode for the life of the
   * session, and on this hub a concurrent HEVC decode is what exhausted the
   * VAAPI device.
   *
   * HomeKit's constraint differs from Alexa's in one way worth knowing: HAP
   * NEGOTIATES the resolution and profile with the controller, so a session
   * that cannot be served by a copy has already promised the controller
   * something. With this off, such a session is REFUSED with a named reason
   * rather than transcoded behind the operator's back — a refusal an operator
   * chose is not a fault, and it must not look like one (D62).
   */
  readonly allowTranscode?: boolean
  /**
   * Keep CamStack's OWN copy of every clip HomeKit Secure Video records from
   * this camera.
   *
   * ON unless the operator says otherwise, and ABSENT MEANS ON — the field did
   * not exist for entries persisted before it, and the reason the tee shipped
   * ahead of everything that will list its output is that HKSV is a SINK: HAP
   * has no read-back, so a stream nobody teed is gone for good (D550). A
   * default of off would mean the feature did nothing until the operator
   * visited every camera, and the clips lost in between are unrecoverable.
   *
   * Off costs nothing and saves the disk and one thumbnail ffmpeg per clip; the
   * HomeKit recording itself is untouched either way.
   */
  readonly keepClips?: boolean
  /**
   * How many days this camera's kept clips survive. Absent = the global
   * default (`clipRetentionDays`), which ships at
   * {@link DEFAULT_CLIP_RETENTION_DAYS}. Resolved ONLY through
   * {@link resolveClipRetentionDays} so reset, unset and never-written are the
   * same value.
   */
  readonly clipRetentionDays?: number
}

export interface ExposedConfigEntry {
  readonly deviceId: string
  readonly displayName: string
  readonly mapperKind: MapperKind
  readonly capabilities?: readonly string[]
  /**
   * UUIDs of every child accessory this exposure produced. Tracked so
   * `unexposeDevice` can remove children deterministically without
   * re-enumerating the parent's children at unexpose time (parent
   * device may already be gone). Empty on entries persisted by
   * Round 1 (motion-sensor-only) — those have no children.
   */
  readonly childAccessoryUuids?: readonly string[]
  /** Ms epoch — useful for diagnostic display. */
  readonly addedAt?: number
  /**
   * Per-device export settings (preferred stream, …). New entries get
   * defaults via `DEFAULT_DEVICE_SETTINGS`. Old entries persisted by
   * pre-settings releases default at read time.
   */
  readonly settings?: ExportDeviceSettings
}

export type HapBridgeExportsBody = {
  readonly name: string
  readonly devices: readonly ExposedConfigEntry[]
  readonly actions: readonly ActionExportEntry[]
}

const ExportDeviceSettingsSchema: z.ZodType<ExportDeviceSettings> = z.object({
  multiTierService: z.boolean().optional(),
  streamPreference: z.string(),
  useBridge: z.boolean().optional(),
  allowTranscode: z.boolean().optional(),
  keepClips: z.boolean().optional(),
  clipRetentionDays: z.number().optional(),
})

const MapperKindSchema: z.ZodType<MapperKind> = z.enum(['camera', 'generic'])

export const ExposedConfigEntrySchema: z.ZodType<ExposedConfigEntry> = z.object({
  deviceId: z.string(),
  displayName: z.string(),
  mapperKind: MapperKindSchema,
  capabilities: z.array(z.string()).optional(),
  childAccessoryUuids: z.array(z.string()).optional(),
  addedAt: z.number().optional(),
  settings: ExportDeviceSettingsSchema.optional(),
})

export const ActionExportEntrySchema: z.ZodType<ActionExportEntry> = z.object({
  actionId: z.string(),
  displayName: z.string(),
  addedAt: z.number(),
})

export const HapBridgeExportsBodySchema: z.ZodType<HapBridgeExportsBody> = z.object({
  name: z.string().min(1),
  devices: z.array(ExposedConfigEntrySchema),
  actions: z.array(ActionExportEntrySchema),
})

/** The label of every exposure record: it is the instance's, not an operator's name. */
export const HAP_EXPOSURE_NAME = 'HomeKit exposure'

export const HAP_BRIDGE_EXPORTS_KIND_NAME = 'hap-bridge-exports'

export const hapBridgeExportsKind: DefinedRecordKind<z.ZodType<HapBridgeExportsBody>> =
  defineEntryKind(HAP_BRIDGE_EXPORTS_KIND_NAME, {
    title: 'HomeKit exposure',
    nameField: 'name',
    schema: HapBridgeExportsBodySchema,
    writeTrigger: 'an operator exposes or unexposes a device or action to HomeKit',
  })

/** The settings keys that moved into the record; the migrations name them. */
export const MOVED_EXPOSURE_KEYS = ['exposed', 'exposedActions'] as const
