import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * camera-credentials — device-scoped cap exposing the camera's network
 * + auth surface in a vendor-neutral shape.
 *
 * Why it exists: cross-vendor wrappers (the planned ONVIF generic addon
 * for PTZ / intercom / events; future homekit / mqtt bridges) need the
 * camera's IP + port + creds without each wrapper re-implementing
 * vendor-specific config-blob extraction. With this cap, every camera
 * provider returns a uniform CameraCredentials and consumers stay
 * vendor-agnostic.
 *
 * Implementations:
 *   - Each camera-providing addon registers this cap natively per
 *     device (Reolink, Hikvision, RTSP, ONVIF self).
 *   - Returns a snapshot from the persisted device config blob — no
 *     extra round-trip to the camera, no probing.
 *   - The cap is admin-only (`auth: 'admin'`) — credentials must not
 *     leak through user-scoped paths.
 *
 * Sensitive data handling:
 *   - getCredentials returns the full snapshot to admin callers only.
 *   - Wrappers are expected to use the value to construct a per-call
 *     client and NOT to log / event-bus-emit the password field.
 *   - The cap status payload (mirrored to runtime-state) carries
 *     non-sensitive metadata only — host + ports + protocol hints. The
 *     password / username live on `getCredentials` exclusively.
 *
 * See `docs/onvif-generic-addon-plan.md` for the consuming wrapper
 * design.
 */

export const CameraCredentialsSchema = z.object({
  /** Camera IP or hostname (no scheme). */
  host: z.string(),
  /** Primary protocol port (varies per vendor: Baichuan 9000, ISAPI 80/443, RTSP 554). */
  port: z.number().int().positive().optional(),
  /** ONVIF service port if known by the provider. */
  onvifPort: z.number().int().positive().optional(),
  /** RTSP service port if known. */
  rtspPort: z.number().int().positive().optional(),
  /** HTTP(S) flag for the primary protocol port. */
  https: z.boolean().optional(),
  /** Login username. */
  username: z.string().optional(),
  /** Login password. CONSUMERS MUST NOT log or event-bus this value. */
  password: z.string().optional(),
  /** ONVIF profile hint advertised by the camera (`T`, `Q`, `G`, `S`). */
  onvifProfile: z.string().optional(),
})

export type CameraCredentials = z.infer<typeof CameraCredentialsSchema>

/**
 * Non-sensitive camera-credentials status — host + ports + protocol
 * hints only. Mirrors what shows up in the bindings UI / device
 * aggregate. The full credentials (with password) are exposed only via
 * `getCredentials` to admin callers.
 */
export const CameraCredentialsStatusSchema = z.object({
  host: z.string(),
  port: z.number().int().positive().nullable(),
  onvifPort: z.number().int().positive().nullable(),
  rtspPort: z.number().int().positive().nullable(),
  https: z.boolean().nullable(),
  hasUsername: z.boolean(),
  hasPassword: z.boolean(),
  onvifProfile: z.string().nullable(),
})

export type CameraCredentialsStatus = z.infer<typeof CameraCredentialsStatusSchema>

export const cameraCredentialsCapability = {
  name: 'camera-credentials',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /**
     * Return the camera's full credential bundle for admin consumers.
     * Each provider implementation returns a snapshot of its persisted
     * config — no I/O to the camera. Returns null when the device is
     * not owned by this addon (deviceId mismatch).
     */
    getCredentials: method(z.object({ deviceId: z.number() }), CameraCredentialsSchema.nullable(), {
      kind: 'query',
      auth: 'admin',
    }),
  },
  status: {
    schema: CameraCredentialsStatusSchema,
    kind: 'command-driven',
  },
} as const satisfies CapabilityDefinition

export type ICameraCredentialsProvider = InferProvider<typeof cameraCredentialsCapability>
