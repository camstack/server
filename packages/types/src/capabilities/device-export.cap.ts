import { z } from 'zod'
import {
  method,
  optionalMethod,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'

/**
 * `device-export` — collection cap for addons that export camstack
 * devices to external ecosystems (HomeAssistant via MQTT discovery,
 * HomeKit/HAP, Alexa Smart Home, …).
 *
 * No `ecosystem` enum — the addon id identifies the export target.
 * Each addon owns its mapping logic in its own settings UI. The cap
 * exposes only the COMMON surface: link state, supported device
 * kinds (so the UI can filter the device picker), and per-device
 * expose/unexpose.
 */

const LinkStateSchema = z.enum(['unlinked', 'linked', 'error'])

/**
 * A single label/value row surfaced in the export panel's "Setup"
 * section. Rendered with a copy-to-clipboard button. `secret: true`
 * rows are masked by default with a reveal toggle (client ids,
 * secrets, …).
 */
const ExportSetupFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  /** Mask the value by default + render a reveal toggle (client id, secrets). */
  secret: z.boolean().optional(),
})

/**
 * Generic, addon-agnostic pairing/account block. Any export addon can
 * surface a scannable QR, a set of copyable label/value rows, and a
 * free-form operator note — the `DeviceExportPanel` renders whatever
 * the provider supplies and skips the section entirely when `setup`
 * is unset.
 */
const ExportSetupSchema = z.object({
  /** A string to render as a scannable QR — HAP `X-HM://…` URI, a pairing URL, etc. Omitted when there's nothing to scan. */
  qr: z.string().optional(),
  /** Label/value rows shown with a copy button (HAP setup code, OAuth URLs, client id, linked-account count, …). */
  fields: z.array(ExportSetupFieldSchema).readonly().optional(),
  /** Free-form operator instructions rendered above the fields. */
  note: z.string().optional(),
})

const DeviceExportStatusSchema = z.object({
  linkState: LinkStateSchema,
  exposedDeviceCount: z.number(),
  error: z.string().optional(),
  /**
   * Optional pairing/account info the panel renders in a generic
   * "Setup" section. Addon-agnostic — the addon id identifies the
   * export target, never an `ecosystem` key here.
   */
  setup: ExportSetupSchema.optional(),
})

const DeviceKindSchema = z.string() // camstack device kind (e.g. 'camera', 'switch')

const ExposedDeviceSchema = z.object({
  deviceId: z.string(),
  exposedAs: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})

const ExposeInputSchema = z.object({
  deviceId: z.string(),
  capabilities: z.array(z.string()).optional(),
})

const UnexposeInputSchema = z.object({ deviceId: z.string() })

/**
 * What an exporter may expose besides devices (D967). An action and a
 * notification target are LIST ENTRIES, never devices (D954): they enter an
 * exporter's own selection, not the device registry.
 */
const ExportEntityKindSchema = z.enum(['device', 'action', 'notifier'])

const ExportEntityRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), deviceId: z.string() }),
  z.object({ kind: z.literal('action'), actionId: z.string().min(1) }),
  z.object({ kind: z.literal('notifier'), targetId: z.string().min(1) }),
])

const ExposedEntitySchema = z.object({
  entity: ExportEntityRefSchema,
  exposedAs: z.string().optional(),
})

const ExposeEntityInputSchema = z.object({ entity: ExportEntityRefSchema })
const UnexposeEntityInputSchema = z.object({ entity: ExportEntityRefSchema })

export const deviceExportCapability = {
  name: 'device-export',
  scope: 'system',
  mode: 'collection',
  providerKind: 'device-export',
  status: { schema: DeviceExportStatusSchema, kind: 'poll' },
  /**
   * Each export provider contributes its own per-device "Export" panel
   * (enabled toggle, preferred stream, addon-specific knobs like the
   * HA-MQTT discovery prefix). The three framework methods
   * `getDeviceSettingsContribution` / `getDeviceLiveContribution` /
   * `applyDeviceSettingsPatch` are auto-injected on the provider
   * interface and routed to the device-details aggregator.
   */
  exposesDeviceSettings: true,
  methods: {
    getStatus: method(z.void(), DeviceExportStatusSchema),
    listSupportedDeviceKinds: method(z.void(), z.array(DeviceKindSchema)),
    listExposedDevices: method(z.void(), z.array(ExposedDeviceSchema)),
    // Publishing a camera to HomeKit / Alexa / Google hands it to another
    // ecosystem's users — an administrator's act, not an operator's (D634 r3).
    // The only UI caller is the admin export panel.
    exposeDevice: method(ExposeInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    unexposeDevice: method(UnexposeInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    // Entities beyond devices (D967). A provider that implements none of these
    // exports devices only; the UI treats an unanswered `listSupportedEntityKinds`
    // as "unknown", never as "devices only" (D315).
    listSupportedEntityKinds: optionalMethod(z.void(), z.array(ExportEntityKindSchema)),
    listExposedEntities: optionalMethod(z.void(), z.array(ExposedEntitySchema)),
    exposeEntity: optionalMethod(ExposeEntityInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    unexposeEntity: optionalMethod(UnexposeEntityInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDeviceExportProvider = InferProvider<typeof deviceExportCapability>

export {
  DeviceExportStatusSchema,
  ExportSetupSchema,
  ExportSetupFieldSchema,
  ExposedDeviceSchema,
  ExposeInputSchema,
  UnexposeInputSchema,
  ExportEntityKindSchema,
  ExportEntityRefSchema,
  ExposedEntitySchema,
  ExposeEntityInputSchema,
  UnexposeEntityInputSchema,
}
export type ExportEntityKind = z.infer<typeof ExportEntityKindSchema>
export type ExportEntityRef = z.infer<typeof ExportEntityRefSchema>
export type ExposedEntity = z.infer<typeof ExposedEntitySchema>
