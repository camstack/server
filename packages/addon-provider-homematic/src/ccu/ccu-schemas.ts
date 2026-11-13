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

export const SetButtonEventsInputSchema = IntegrationRefSchema.extend({
  /** Key-channel address, e.g. `00315F298E5093:1`. */
  address: z.string().min(1),
  enabled: z.boolean(),
  confirmed: ConfirmedSchema,
})

// ── Devices ────────────────────────────────────────────────────────────────

/** A channel a key channel actuates through a direct link. */
export const KeyDirectLinkSchema = z.object({
  receiver: z.string(),
  receiverName: z.string().nullable(),
  receiverDeviceName: z.string().nullable(),
})
export type KeyDirectLink = z.infer<typeof KeyDirectLinkSchema>

/**
 * One key channel's central-link state and the channels it actuates directly.
 * `unknown` is a read that failed, never `off`; its `links` are then empty
 * because they were not read, not because there are none.
 */
export const KeyChannelLinkSchema = z.object({
  address: z.string(),
  index: z.string(),
  name: z.string().nullable(),
  central: z.enum(['on', 'off', 'unknown']),
  links: z.array(KeyDirectLinkSchema),
})
export type KeyChannelLink = z.infer<typeof KeyChannelLinkSchema>

/** A channel of a CCU device as the CCU names it (`null`: the CCU holds no name). */
export const CcuChannelRowSchema = z.object({
  address: z.string(),
  index: z.number(),
  type: z.string().nullable(),
  name: z.string().nullable(),
})
export type CcuChannelRow = z.infer<typeof CcuChannelRowSchema>

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
  /**
   * CamStack device id when this CCU device is adopted as a container.
   * `null` when it is not adopted — the page then has nowhere to link.
   */
  deviceId: z.number().int().nullable().default(null),
  /**
   * Key channels of an ADOPTED device, and whether the CCU sends their presses
   * (a central link). Empty for a device that is not adopted or has no keys.
   */
  keyChannels: z.array(KeyChannelLinkSchema).default([]),
  /** Every channel but the maintenance channel (index 0), for renaming. */
  channels: z.array(CcuChannelRowSchema).default([]),
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

// ── Direct links ───────────────────────────────────────────────────────────

/** What one key press does on a key → switch link (`none` ignores the press). */
export const LINK_PRESS_ACTIONS = ['toggle', 'on', 'off', 'none'] as const
export const LinkPressActionSchema = z.enum(LINK_PRESS_ACTIONS)
export type LinkPressAction = z.infer<typeof LinkPressActionSchema>

/**
 * The resolved profile of a link: `switch` carries the catalogue actions,
 * `custom` is a key → switch link whose settings match no catalogue entry (it
 * is shown, never rewritten), `null` is any link no catalogue applies to.
 */
export const LinkProfileSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('switch'),
      short: LinkPressActionSchema,
      long: LinkPressActionSchema,
    }),
    z.object({ kind: z.literal('custom') }),
  ])
  .nullable()
export type LinkProfile = z.infer<typeof LinkProfileSchema>

/** A channel as the CCU names it; names are `null` when the CCU holds none. */
export const LinkEndpointSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  deviceName: z.string().nullable(),
  deviceType: z.string().nullable(),
})
export type LinkEndpoint = z.infer<typeof LinkEndpointSchema>

export const CcuLinkSchema = z.object({
  sender: LinkEndpointSchema,
  receiver: LinkEndpointSchema,
  name: z.string(),
  description: z.string(),
  profile: LinkProfileSchema,
})
export type CcuLink = z.infer<typeof CcuLinkSchema>

/** A device whose links could not be read: named, so a partial list never reads as complete. */
export const LinkReadFailureSchema = z.object({
  address: z.string(),
  deviceName: z.string().nullable(),
  error: z.string(),
})
export type LinkReadFailure = z.infer<typeof LinkReadFailureSchema>

export const CcuLinksResultSchema = z.object({
  links: z.array(CcuLinkSchema),
  /** Key channels a new link may start from. */
  senders: z.array(LinkEndpointSchema),
  /** Switch actuator channels a new link may end at. */
  receivers: z.array(LinkEndpointSchema),
  failures: z.array(LinkReadFailureSchema),
})
export type CcuLinksResult = z.infer<typeof CcuLinksResultSchema>

// ── Programs ───────────────────────────────────────────────────────────────

/** A channel a program's conditions use, named from CamStack when the device is adopted. */
export const ProgramChannelSchema = z.object({
  address: z.string(),
  channelName: z.string().nullable(),
  /** CamStack device name when the channel's device is adopted, otherwise the CCU name. */
  deviceName: z.string().nullable(),
  deviceId: z.number().int().nullable(),
})
export type ProgramChannel = z.infer<typeof ProgramChannelSchema>

export const CcuProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  internal: z.boolean(),
  /** Epoch milliseconds. `null` when the CCU has no last run, or the run is epoch 0. */
  lastRunMs: z.number().nullable(),
  /** The name is the key-event program CamStack creates (`CamStack: … events`). */
  createdByCamstack: z.boolean(),
  channels: z.array(ProgramChannelSchema),
})
export type CcuProgram = z.infer<typeof CcuProgramSchema>

/** A HmIP key channel a new key-event program may listen to. */
export const ProgramKeySchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  deviceAddress: z.string(),
  deviceName: z.string().nullable(),
  deviceType: z.string(),
})
export type ProgramKey = z.infer<typeof ProgramKeySchema>

export const CcuProgramsResultSchema = z.object({
  programs: z.array(CcuProgramSchema),
  keys: z.array(ProgramKeySchema),
})
export type CcuProgramsResult = z.infer<typeof CcuProgramsResultSchema>

export const ProgramIdInputSchema = IntegrationRefSchema.extend({
  programId: z.string().min(1),
  confirmed: ConfirmedSchema,
})
export type ProgramIdInput = z.infer<typeof ProgramIdInputSchema>

export const SetProgramActiveInputSchema = ProgramIdInputSchema.extend({
  active: z.boolean(),
})
export type SetProgramActiveInput = z.infer<typeof SetProgramActiveInputSchema>

/** Create or rewrite the one key-event program of a HmIP button device. */
export const EnsureKeyEventProgramInputSchema = IntegrationRefSchema.extend({
  deviceAddress: z.string().min(1),
  channelAddresses: z.array(z.string().min(1)).min(1),
  confirmed: ConfirmedSchema,
})
export type EnsureKeyEventProgramInput = z.infer<typeof EnsureKeyEventProgramInputSchema>

export const LinkRefInputSchema = IntegrationRefSchema.extend({
  sender: z.string().min(1),
  receiver: z.string().min(1),
  confirmed: ConfirmedSchema,
})

export const LinkProfileInputSchema = LinkRefInputSchema.extend({
  short: LinkPressActionSchema,
  long: LinkPressActionSchema,
})

// ── Names ──────────────────────────────────────────────────────────────────

/** A device or channel with the name the CCU now holds (it may adjust a name to keep it unique). */
export const NamedObjectSchema = z.object({ address: z.string(), name: z.string() })

export const DeviceRenameResultSchema = z.object({
  device: NamedObjectSchema,
  /** The renamed channels; empty when the channels were left alone. */
  channels: z.array(NamedObjectSchema),
})
export type DeviceRenameResult = z.infer<typeof DeviceRenameResultSchema>

export const RenameDeviceInputSchema = IntegrationRefSchema.extend({
  address: z.string().min(1),
  name: z.string(),
  /** Also rename every channel to `<name>:<index>` (the CCU's own pattern). */
  renameChannels: z.boolean(),
  confirmed: ConfirmedSchema,
})

export const RenameChannelInputSchema = IntegrationRefSchema.extend({
  address: z.string().min(1),
  name: z.string(),
  confirmed: ConfirmedSchema,
})

// ── Rooms ──────────────────────────────────────────────────────────────────

export const CcuRoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Member channels, named as the CCU names them. */
  channels: z.array(LinkEndpointSchema),
})
export type CcuRoom = z.infer<typeof CcuRoomSchema>

export const CcuRoomsResultSchema = z.object({
  rooms: z.array(CcuRoomSchema),
  /** Every channel a room may hold (the maintenance channels excluded). */
  channels: z.array(LinkEndpointSchema),
})
export type CcuRoomsResult = z.infer<typeof CcuRoomsResultSchema>

export const CreateRoomInputSchema = IntegrationRefSchema.extend({
  name: z.string(),
  confirmed: ConfirmedSchema,
})

export const RenameRoomInputSchema = IntegrationRefSchema.extend({
  id: z.string().min(1),
  name: z.string(),
  confirmed: ConfirmedSchema,
})

export const DeleteRoomInputSchema = IntegrationRefSchema.extend({
  id: z.string().min(1),
  confirmed: ConfirmedSchema,
})

/** The room's whole member list after the edit; the handler adds and removes the difference. */
export const SetRoomChannelsInputSchema = IntegrationRefSchema.extend({
  id: z.string().min(1),
  channels: z.array(z.string().min(1)),
  confirmed: ConfirmedSchema,
})

export const RoomChannelsResultSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
})

// ── Device detail (the device page panel) ─────────────────────────────────

/** One VALUES parameter of a channel: its current value and what a write may send. */
export const ValueParamSchema = ConfigParamSchema.extend({
  /** False for a write-only parameter (a key press); its `value` is then meaningless. */
  readable: z.boolean(),
})
export type ValueParam = z.infer<typeof ValueParamSchema>

export const ChannelValuesSchema = z.object({
  address: z.string(),
  index: z.number(),
  type: z.string().nullable(),
  name: z.string().nullable(),
  values: z.array(ValueParamSchema),
})
export type ChannelValues = z.infer<typeof ChannelValuesSchema>

/** The maintenance readings; `null` = the device has no such reading (never "false"). */
export const DeviceDiagnosticsSchema = z.object({
  rssiDevice: z.number().nullable(),
  rssiPeer: z.number().nullable(),
  unreach: z.boolean().nullable(),
  lowBattery: z.boolean().nullable(),
  /** HmIP reports a flag (duty cycle reached), BidCos a percentage. */
  dutyCycle: z.union([z.boolean(), z.number()]).nullable(),
  configPending: z.boolean().nullable(),
})
export type DeviceDiagnostics = z.infer<typeof DeviceDiagnosticsSchema>

export const DeviceFirmwareSchema = z.object({
  installed: z.string().nullable(),
  available: z.string().nullable(),
  updatable: z.boolean().nullable(),
  state: z.string().nullable(),
})

export const CcuDeviceStateSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  type: z.string(),
  firmware: DeviceFirmwareSchema,
  diagnostics: DeviceDiagnosticsSchema,
  channels: z.array(ChannelValuesSchema),
})
export type CcuDeviceState = z.infer<typeof CcuDeviceStateSchema>

export const SetValueInputSchema = IntegrationRefSchema.extend({
  channel: z.string().min(1),
  parameter: z.string().min(1),
  value: ConfigValueSchema,
  /** The CamStack device the write was made from, for the log line's tag. */
  deviceId: z.number().int().optional(),
  confirmed: ConfirmedSchema,
})
