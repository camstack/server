import { z } from 'zod'
import {
  method,
  optionalMethod,
  type CapabilityDefinition,
  type DeviceSettingsContribution,
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
  /**
   * What this instance's platform accepts as a device name, in one operator-facing sentence
   * (D1049). The derived "Name on <instance>" field shows it; absent = the field says nothing
   * about the rule.
   */
  nameRule: z.string().optional(),
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

/**
 * EXPOSED NAME. What one instance calls a device on its platform, when it should not be the
 * device's own name. The exporter owns it: it is stored per instance in the exporter's per-device
 * store (D865), validated by the exporter against its platform's naming rules, and never reaches
 * the exported id — a rename updates the SAME device on the platform, never a second one.
 * Blank or `null` = the device's own name. A name the platform would refuse is refused with
 * `ExportNameRefusedError` (`export-name-refused`), whose message says why.
 */
const ExposedDeviceSchema = z.object({
  deviceId: z.string(),
  exposedAs: z.string().optional(),
  /** The operator's name for this device on this instance; absent = the device's own name. */
  exposedName: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})

const ExposeInputSchema = z.object({
  instanceId: InstanceIdSchema,
  deviceId: z.string(),
  capabilities: z.array(z.string()).optional(),
  /** Set the exposed name in the same call; absent = leave it as it is, blank/null = clear it. */
  exposedName: z.string().nullable().optional(),
})

const SetExposedNameInputSchema = z.object({
  instanceId: InstanceIdSchema,
  deviceId: z.string(),
  /** Blank or null = the device's own name. */
  name: z.string().nullable(),
  /**
   * Validate only: refuse exactly as a real call would, write nothing. A caller saving several
   * names at once checks every one first, so one refusal writes none (D1049).
   */
  dryRun: z.boolean().optional(),
})

export const EXPORT_NAME_REFUSED = 'export-name-refused'

/** A name the instance's platform would refuse. The message starts with the code, then the reason. */
export class ExportNameRefusedError extends Error {
  readonly code = EXPORT_NAME_REFUSED
  readonly instanceId: string
  readonly reason: string

  constructor(instanceId: string, reason: string) {
    super(`${EXPORT_NAME_REFUSED}: ${reason}`)
    this.name = 'ExportNameRefusedError'
    this.instanceId = instanceId
    this.reason = reason
  }
}

const UnexposeInputSchema = z.object({
  instanceId: InstanceIdSchema,
  deviceId: z.string(),
})

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
   * Each export provider MAY contribute its own per-device "Export" panel
   * (enabled toggle, preferred stream, addon-specific knobs). The three
   * framework methods are mounted on the cap router when present.
   * `IDeviceExportProvider` leaves them optional: an exporter with no
   * per-device panel omits them (a `deviceConfig` cap's UI is derived and
   * never hand-written — D14 — and an exporter is not one of those).
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
    // Renaming what another ecosystem's users see is the same administrator's act as exposing.
    setExposedName: method(SetExposedNameInputSchema, z.void(), {
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
  vocabulary: {
    notOperatorFacing: 'exports to other ecosystems — configured on the export pages',
  },
} as const satisfies CapabilityDefinition

type DeviceExportInferred = InferProvider<typeof deviceExportCapability>

/**
 * Author-facing provider. The router still mounts the three contribution
 * methods (`exposesDeviceSettings`), but a provider that has no per-device
 * panel omits them. Addons that implement the methods stay assignable.
 */
export type IDeviceExportProvider = Omit<DeviceExportInferred, keyof DeviceSettingsContribution> &
  Partial<Pick<DeviceExportInferred, keyof DeviceSettingsContribution>>

export {
  InstancePinSchema,
  ExportInstanceSchema,
  DeviceExportStatusSchema,
  ExportSetupSchema,
  ExportSetupFieldSchema,
  ExposedDeviceSchema,
  ExposeInputSchema,
  UnexposeInputSchema,
  SetExposedNameInputSchema,
  ExportEntityKindSchema,
  ExportEntityRefSchema,
  ExposedEntitySchema,
  ExposeEntityInputSchema,
  UnexposeEntityInputSchema,
}
export type ExportInstance = z.infer<typeof ExportInstanceSchema>
export type SetExposedNameInput = z.infer<typeof SetExposedNameInputSchema>
export type ExportEntityKind = z.infer<typeof ExportEntityKindSchema>
export type ExportEntityRef = z.infer<typeof ExportEntityRefSchema>
export type ExposedEntity = z.infer<typeof ExposedEntitySchema>
