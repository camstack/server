import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Image display cap. Models a single still image exposed by an integration —
 * a snapshot, a chart, a generated picture, or a robot's cleaning-map render.
 *
 * Read-only: there are no setters. The provider resolves whatever upstream
 * source it has into an ABSOLUTE URL the browser loads directly:
 *   - HA `image.*` entities → the `entity_picture` signed-token path
 *     (token stays in the query string, so no auth header is needed);
 *   - a Dreame/robot map → the cloud/OSS map-image URL (or an addon
 *     data-plane URL serving the rendered map bytes), exposed as its own
 *     Image child device grouped under the robot's container.
 * The slice carries that URL plus the upstream last-updated timestamp; the
 * image changes when the source's last-updated marker changes.
 */
export const ImageStatusSchema = z.object({
  /** Absolute signed URL the browser loads directly. Null when the
   *  entity exposes no `entity_picture` (yet). */
  url: z.string().nullable(),
  /** Ms epoch of the upstream last-updated timestamp. Null at cold-start. */
  lastUpdated: z.number().nullable(),
})

export type ImageStatus = z.infer<typeof ImageStatusSchema>

export const imageCapability = {
  name: 'image',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Image],
  // Read-only — no service methods. Codegen still auto-injects `getStatus`
  // because `status` is set.
  methods: {},
  status: {
    schema: ImageStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. The UI reads `url`
   * directly and renders the still image.
   */
  runtimeState: ImageStatusSchema,

  /**
   * Runtime-state durability: **session** — a snapshot URL is a session-scoped handle; a restored one points at nothing.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — not numeric.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IImageProvider = InferProvider<typeof imageCapability>
