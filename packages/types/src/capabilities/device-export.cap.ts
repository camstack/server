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
 *
 * INSTANCES. One export addon can serve several independent targets (a
 * HomeKit bridge, a Home Assistant broker). `listInstances` names them.
 * `instanceId` on a READ is optional: absent = the whole addon (linked if any
 * enabled instance is, `exposedDeviceCount` = distinct devices, `setup` = the
 * default instance's); present = that instance; an id the provider does not
 * serve is refused with `ExportInstanceUnknownError` (`export-instance-unknown`),
 * never answered empty. `instanceId` on a WRITE is REQUIRED: a membership
 * change always names the target it changes. A single-instance provider
 * accepts an absent id on a read or its own id, and refuses any other.
 */

/** Which instance of an export addon a call addresses. Absent on a read = the whole addon. */
const InstanceIdSchema = z.string().min(1)
const InstancePinSchema = z.object({ instanceId: InstanceIdSchema.optional() })

/** One independent export target of an addon. */
const ExportInstanceSchema = z.object({
  instanceId: InstanceIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  kind: z.string().optional(),
})

export const EXPORT_INSTANCE_UNKNOWN = 'export-instance-unknown'

/** The named failure of an `instanceId` the provider does not serve. The message starts with the code. */
export class ExportInstanceUnknownError extends Error {
  readonly code = EXPORT_INSTANCE_UNKNOWN
  readonly instanceId: string

  constructor(addon: string, instanceId: string) {
    super(`${EXPORT_INSTANCE_UNKNOWN}: ${addon} serves no instance "${instanceId}"`)
    this.name = 'ExportInstanceUnknownError'
    this.instanceId = instanceId
  }
}

/**
 * The instance a `getStatus` call names. The cap's `status` block injects a per-device
 * `getStatus({ deviceId })` beside the method's own `{ instanceId? }`, so the provider sees
 * both shapes; only the second names an instance (a per-device status read is addon-wide).
 */
export function statusInstanceOf(
  input: { readonly instanceId?: string } | { readonly deviceId: number },
): string | undefined {
  return 'instanceId' in input ? input.instanceId : undefined
}

/**
 * A single-instance provider's check: an absent id or its own passes, any other throws
 * `ExportInstanceUnknownError`.
 */
export function assertOwnExportInstance(
  addon: string,
  own: string,
  instanceId: string | undefined,
): void {
  if (instanceId !== undefined && instanceId !== own) {
    throw new ExportInstanceUnknownError(addon, instanceId)
  }
}

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
  instanceId: InstanceIdSchema,
  deviceId: z.string(),
  capabilities: z.array(z.string()).optional(),
})

const UnexposeInputSchema = z.object({ instanceId: InstanceIdSchema, deviceId: z.string() })

/**
 * What an exporter may expose besides devices (D968). An action and a
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

const ExposeEntityInputSchema = z.object({
  instanceId: InstanceIdSchema,
  entity: ExportEntityRefSchema,
})
const UnexposeEntityInputSchema = z.object({
  instanceId: InstanceIdSchema,
  entity: ExportEntityRefSchema,
})

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
    getStatus: method(InstancePinSchema, DeviceExportStatusSchema),
    listInstances: method(z.void(), z.array(ExportInstanceSchema)),
    listSupportedDeviceKinds: method(InstancePinSchema, z.array(DeviceKindSchema)),
    listExposedDevices: method(InstancePinSchema, z.array(ExposedDeviceSchema)),
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
    // Entities beyond devices (D968). A provider that implements none of these
    // exports devices only; the UI treats an unanswered `listSupportedEntityKinds`
    // as "unknown", never as "devices only" (D315).
    listSupportedEntityKinds: optionalMethod(z.void(), z.array(ExportEntityKindSchema)),
    listExposedEntities: optionalMethod(InstancePinSchema, z.array(ExposedEntitySchema)),
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
  InstancePinSchema,
  ExportInstanceSchema,
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
export type ExportInstance = z.infer<typeof ExportInstanceSchema>
export type ExportEntityKind = z.infer<typeof ExportEntityKindSchema>
export type ExportEntityRef = z.infer<typeof ExportEntityRefSchema>
export type ExposedEntity = z.infer<typeof ExposedEntitySchema>
