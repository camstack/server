import { z } from 'zod'
import { amcrestExtrasSnapshotSchema } from './extra-settings.js'

/** Addon id — must match `package.json`'s `camstack.addons[0].id`. */
export const AMCREST_ADDON_ID = 'provider-amcrest'

/** Single-sensor Amcrest/Dahua cameras are always channel 1. Multi-channel
 *  NVRs would enumerate 1..N; the first pass targets single cameras. */
export const DEFAULT_CHANNEL = 1

/**
 * Persisted probe snapshot — filled by `onCreateDevice` from the
 * `magicBox.cgi` device-info probe. `mac` (when resolved) drives
 * `generateStableId`'s durable `mac-<mac>` key. All fields optional so a
 * partial probe still persists.
 */
export const amcrestDeviceCacheSchema = z
  .object({
    deviceType: z.string(),
    model: z.string(),
    serialNumber: z.string(),
    firmwareVersion: z.string(),
    hardwareVersion: z.string(),
    processor: z.string(),
    mac: z.string(),
    hasPtz: z.boolean(),
    probedAt: z.number(),
    /**
     * Last camera read of the driver-authored extras (IR illuminator,
     * status LED, NTP, auto-reboot). Seeds the settings-form defaults —
     * the CAMERA stays the authority (D62): saves write CGI and re-read
     * into this snapshot, never into standalone config keys.
     */
    extras: amcrestExtrasSnapshotSchema,
  })
  .partial()

export type AmcrestDeviceCache = z.infer<typeof amcrestDeviceCacheSchema>

/**
 * Amcrest/Dahua camera hardware config. `name`/`location` are base
 * device-meta (resolved by `BaseDevice`), NOT part of this schema — this
 * carries only the technical connection knobs.
 */
export const amcrestCameraSchema = z.object({
  /**
   * Which preset `ptz.goHome` targets on THIS camera.
   *
   * Empty = nothing configured, and `goHome` then REFUSES. It used to go to a
   * hardcoded slot on a vendor "convention" this fleet contradicts: reolink
   * went to preset 0, which on device 107 holds "stanza"; amcrest went to
   * preset 1, which on device 3836 holds "Preset1". Both swallowed the failure
   * in a bare catch, so a head that never moved was indistinguishable from a
   * head that went home.
   */
  homePresetId: z
    .string()
    .default('')
    .describe('Preset id ptz.goHome targets (empty = goHome refuses)'),
  host: z.string().describe('Camera IP / hostname'),
  port: z.number().int().min(1).max(65535).default(80).describe('HTTP CGI port'),
  https: z.boolean().default(false).describe('Use HTTPS for CGI'),
  username: z.string().default('admin').describe('Username'),
  password: z.string().default('').describe('Password').meta({ secret: true }),
  channel: z.number().int().min(1).default(DEFAULT_CHANNEL).describe('Camera channel (1-based)'),
  deviceCache: amcrestDeviceCacheSchema.optional(),
})

export type AmcrestCameraConfig = z.infer<typeof amcrestCameraSchema>
