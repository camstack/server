import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic on-screen-display (video overlay) cap. Each camera exposes
 * a firmware-defined list of overlays (channel name, timestamp,
 * watermark, logo, …); the cap models them as a homogeneous array of
 * descriptors so the admin UI can render them with zero per-firmware
 * code.
 */

export const OsdOverlayKindEnum = z.enum(['text', 'timestamp', 'watermark'])
export type OsdOverlayKind = z.infer<typeof OsdOverlayKindEnum>

export const OsdPositionEnum = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'custom',
])
export type OsdPosition = z.infer<typeof OsdPositionEnum>

export const OsdOverlaySchema = z.object({
  /** Stable driver-assigned id. Reolink uses `'channel'`, `'time'`, `'watermark'`. */
  id: z.string(),
  kind: OsdOverlayKindEnum,
  enabled: z.boolean(),
  /** Active text (text/watermark). Undefined for 'timestamp' (firmware-generated). */
  text: z.string().optional(),
  position: OsdPositionEnum.optional(),
  /**
   * Positions the firmware accepts for this specific overlay. Populated
   * by the driver at register time. Empty array → positioning not
   * configurable; the UI hides the position field.
   */
  availablePositions: z.array(OsdPositionEnum).readonly(),
  /** Firmware does not allow editing the `text` field (e.g. timestamp). */
  readOnly: z.boolean().optional(),
  /**
   * Firmware text ceiling for this overlay. Absent = no known limit.
   * The OSD manager truncates here on every write — never stores its own
   * copy on the binding.
   */
  maxCharacters: z.number().int().positive().optional(),
})

export type OsdOverlay = z.infer<typeof OsdOverlaySchema>

export const OsdStatusSchema = z.object({
  overlays: z.array(OsdOverlaySchema).readonly(),
})

export type OsdStatus = z.infer<typeof OsdStatusSchema>

const OsdOverlayPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z.string().optional(),
    position: OsdPositionEnum.optional(),
  })
  .partial()

export const osdCapability = {
  name: 'osd',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    /**
     * Patch a single overlay by id. Provider handles read-modify-write
     * against firmware APIs that require the full object (Reolink
     * `SetOsd`). Omitted patch keys are preserved. Successful
     * completion triggers `onStatusChanged`.
     */
    setOverlay: method(
      z.object({
        deviceId: z.number(),
        overlayId: z.string(),
        patch: OsdOverlayPatchSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  events: {
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: OsdStatusSchema,
      }),
    },
  },
  status: {
    schema: OsdStatusSchema,
    kind: 'command-driven',
  },
  settings: {
    bindings: [
      {
        kind: 'array',
        statusPath: 'overlays',
        idField: 'id',
        method: 'setOverlay',
        idArg: 'overlayId',
        patchArg: 'patch',
        sectionId: 'osd',
        sectionTitle: 'Video overlays',
        itemFields: {
          enabled: {
            label: (o) => `${String(o.id)} enabled`,
            kind: 'boolean',
          },
          text: {
            label: (o) => `${String(o.id)} text`,
            kind: 'text',
            when: (o) => o.kind !== 'timestamp' && !o.readOnly,
          },
          position: {
            label: (o) => `${String(o.id)} position`,
            kind: 'select',
            options: (o) => (o.availablePositions as readonly string[] | undefined) ?? [],
            when: (o) => Array.isArray(o.availablePositions) && o.availablePositions.length > 0,
          },
        },
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IOsdProvider = InferProvider<typeof osdCapability>
export { OsdOverlayPatchSchema }
