import { z } from 'zod'

/**
 * Wire shapes of the CCU management custom actions. Shared by the addon (handler
 * output validation) and the admin page (parsing what comes back), so the two
 * can never describe the same payload differently.
 *
 * A CCU write input always carries `confirmed: true`: the page asks the
 * operator first, and the handler refuses a call that did not say so.
 */

export const IntegrationRefSchema = z.object({ integrationId: z.string().min(1) })

/**
 * What the UI sends once the operator confirmed a CCU write. A boolean, not a
 * literal: the handler itself refuses `false` / absent with a named error
 * ({@link requireConfirmed}) instead of the schema's generic rejection.
 */
export const ConfirmedSchema = z.boolean()

export const CcuListItemSchema = z.object({
  integrationId: z.string(),
  name: z.string(),
  connected: z.boolean(),
})
export type CcuListItem = z.infer<typeof CcuListItemSchema>

export const CcuInfoSchema = z.object({
  version: z.string().nullable(),
  product: z.string().nullable(),
  productFamily: z.enum(['ccu3', 'openccu', 'unknown']),
  platform: z.string().nullable(),
  serial: z.string().nullable(),
  hostname: z.string().nullable(),
})

export const RadioGatewaySchema = z.object({
  address: z.string(),
  description: z.string().nullable(),
  dutyCycle: z.number().nullable(),
  connected: z.boolean().nullable(),
  isDefault: z.boolean(),
  firmware: z.string().nullable(),
  type: z.string().nullable(),
})

export const CcuInterfaceSchema = z.object({
  name: z.string(),
  port: z.number().nullable(),
  info: z.string().nullable(),
  connected: z.boolean().nullable(),
  dutyCycle: z.number().nullable(),
  firmware: z.string().nullable(),
  type: z.string().nullable(),
  gateways: z.array(RadioGatewaySchema),
})

/**
 * A section the CCU could not answer carries its reason instead of being
 * silently empty: "no WebUI credentials" and "nothing to report" must not look
 * the same.
 */
export const CcuOverviewSchema = z.object({
  info: CcuInfoSchema.nullable(),
  infoError: z.string().nullable(),
  interfaces: z.array(CcuInterfaceSchema),
  interfacesError: z.string().nullable(),
})
export type CcuOverview = z.infer<typeof CcuOverviewSchema>

export const ServiceMessageSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  channel: z.number().nullable(),
  type: z.string().nullable(),
  timestamp: z.number().nullable(),
  acknowledgeable: z.boolean(),
})
export type ServiceMessage = z.infer<typeof ServiceMessageSchema>

export const ServiceMessagesResultSchema = z.object({
  messages: z.array(ServiceMessageSchema),
  error: z.string().nullable(),
})
export type ServiceMessagesResult = z.infer<typeof ServiceMessagesResultSchema>

export const AcknowledgeInputSchema = IntegrationRefSchema.extend({
  id: z.string().min(1),
  confirmed: ConfirmedSchema,
})

export const OkResultSchema = z.object({ ok: z.literal(true) })

// ── Devices ────────────────────────────────────────────────────────────────

export const CcuDeviceRowSchema = z.object({
  address: z.string(),
  type: z.string(),
  name: z.string().nullable(),
  rooms: z.array(z.string()),
  functions: z.array(z.string()),
  firmware: z.string().nullable(),
  availableFirmware: z.string().nullable(),
  updatable: z.boolean().nullable(),
  /** Signal at the device, dBm; `null` when the device reports none (or the "unknown" marker). */
  rssi: z.number().nullable(),
  /** Signal at the peer, dBm. */
  rssiPeer: z.number().nullable(),
  /** Duty cycle in percent, for devices that report a number. */
  dutyCycle: z.number().nullable(),
  /** HmIP devices report a limit-reached flag instead of a percentage. */
  dutyCycleLimited: z.boolean().nullable(),
  lowBattery: z.boolean().nullable(),
  unreach: z.boolean().nullable(),
  configPending: z.boolean().nullable(),
  sabotage: z.boolean().nullable(),
})
export type CcuDeviceRow = z.infer<typeof CcuDeviceRowSchema>

export const CcuDevicesResultSchema = z.object({ devices: z.array(CcuDeviceRowSchema) })

// ── Heating groups ─────────────────────────────────────────────────────────

/** The group types the CCU can create (nodehomematic `HmGroupCreate.type`). */
export const HEATING_GROUP_TYPES = ['hmip.heating.group', 'HomeMatic.heating'] as const

export const GroupMemberSchema = z.object({
  /** Channel address, e.g. `000A9D89A7AF25:1`. */
  address: z.string(),
  type: z.string(),
  /** The owning device's name, when the CCU names it. */
  deviceName: z.string().nullable(),
})

export const HeatingGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  typeLabel: z.string().nullable(),
  deviceAddress: z.string().nullable(),
  forbidSingleOperation: z.boolean(),
  members: z.array(GroupMemberSchema),
})
export type HeatingGroup = z.infer<typeof HeatingGroupSchema>

export const ThermostatSchema = z.object({
  device: z.string(),
  channel: z.string(),
  name: z.string().nullable(),
  currentTemperature: z.number().nullable(),
  targetTemperature: z.number().nullable(),
  mode: z.enum(['auto', 'heat', 'off']),
  activity: z.enum(['heating', 'idle', 'off']),
})
export type Thermostat = z.infer<typeof ThermostatSchema>

export const GroupCandidateSchema = z.object({
  /** Channel address a group can take as member. */
  address: z.string(),
  type: z.string(),
  deviceName: z.string().nullable(),
})
export type GroupCandidate = z.infer<typeof GroupCandidateSchema>

export const HeatingOverviewSchema = z.object({
  groups: z.array(HeatingGroupSchema),
  /** Why the groups could not be read (no WebUI credentials, ...); `null` when they were. */
  groupsError: z.string().nullable(),
  thermostats: z.array(ThermostatSchema),
  candidates: z.array(GroupCandidateSchema),
})
export type HeatingOverview = z.infer<typeof HeatingOverviewSchema>

export const CreateGroupInputSchema = IntegrationRefSchema.extend({
  name: z.string(),
  type: z.enum(HEATING_GROUP_TYPES),
  members: z.array(z.string()),
  confirmed: ConfirmedSchema,
})

export const UpdateGroupInputSchema = IntegrationRefSchema.extend({
  id: z.number(),
  name: z.string().optional(),
  /** The FULL new member list, not a delta. */
  members: z.array(z.string()).optional(),
  confirmed: ConfirmedSchema,
})

export const DeleteGroupInputSchema = IntegrationRefSchema.extend({
  id: z.number(),
  confirmed: ConfirmedSchema,
})

// ── Pairing ────────────────────────────────────────────────────────────────

export const INSTALL_MODES = ['normal', 'secure'] as const

export const PairingInterfaceSchema = z.object({
  name: z.string(),
  /** Seconds left of the pairing window; `null` = the CCU did not say (never read as 0). */
  secondsLeft: z.number().nullable(),
  /** BidCos only: `secure` also teaches the HomeMatic Secure key. */
  supportsSecure: z.boolean(),
  error: z.string().nullable(),
})
export type PairingInterface = z.infer<typeof PairingInterfaceSchema>

export const PairingStatusSchema = z.object({
  interfaces: z.array(PairingInterfaceSchema),
  error: z.string().nullable(),
})
export type PairingStatus = z.infer<typeof PairingStatusSchema>

export const SetInstallModeInputSchema = IntegrationRefSchema.extend({
  interface: z.string().min(1),
  on: z.boolean(),
  seconds: z.number().int().min(1).max(3600).optional(),
  mode: z.enum(INSTALL_MODES).optional(),
  confirmed: ConfirmedSchema,
})

export const DeleteCcuDeviceInputSchema = IntegrationRefSchema.extend({
  address: z.string().min(1),
  /** Factory-reset the device while removing it. */
  reset: z.boolean(),
  /** Remove it even when it is not reachable. */
  force: z.boolean(),
  confirmed: ConfirmedSchema,
})

// ── MASTER configuration ───────────────────────────────────────────────────

export const ConfigValueSchema = z.union([z.boolean(), z.number(), z.string(), z.null()])
export type ConfigValue = z.infer<typeof ConfigValueSchema>

export const ConfigParamSchema = z.object({
  parameter: z.string(),
  /** `BOOL`, `INTEGER`, `FLOAT`, `ENUM`, `STRING`, ... as the CCU spells it. */
  type: z.string(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.string().nullable(),
  valueList: z.array(z.string()).nullable(),
  writable: z.boolean(),
  /** The current value; `null` when the CCU did not answer for it (never a made-up default). */
  value: ConfigValueSchema,
})
export type ConfigParam = z.infer<typeof ConfigParamSchema>

export const ChannelConfigSchema = z.object({
  channel: z.string(),
  channelType: z.string().nullable(),
  params: z.array(ConfigParamSchema),
  /** Why the values could not be read; the parameter list is then shown without values. */
  error: z.string().nullable(),
})
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>

export const DeviceConfigSchema = z.object({ channels: z.array(ChannelConfigSchema) })
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>

export const DeviceRefSchema = IntegrationRefSchema.extend({ address: z.string().min(1) })

export const SetChannelConfigInputSchema = IntegrationRefSchema.extend({
  channel: z.string().min(1),
  values: z.record(z.string(), ConfigValueSchema),
  confirmed: ConfirmedSchema,
})
