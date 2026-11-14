import { customAction, defineCustomActions } from '@camstack/types'
import type { HmKeyEventDiagnosis } from 'nodehomematic'
import { z } from 'zod'
import {
  AcknowledgeInputSchema,
  CcuDeviceStateSchema,
  CcuDevicesResultSchema,
  CcuLinksResultSchema,
  CcuListItemSchema,
  CcuOverviewSchema,
  CcuProgramsResultSchema,
  CcuRoomSchema,
  CcuRoomsResultSchema,
  CreateGroupInputSchema,
  CreateRoomInputSchema,
  DeleteCcuDeviceInputSchema,
  DeleteGroupInputSchema,
  DeleteRoomInputSchema,
  DeviceConfigSchema,
  DeviceRefSchema,
  DeviceRenameResultSchema,
  EnsureKeyEventProgramInputSchema,
  HeatingGroupSchema,
  HeatingOverviewSchema,
  IntegrationRefSchema,
  LinkProfileInputSchema,
  LinkRefInputSchema,
  NamedObjectSchema,
  OkResultSchema,
  PairingStatusSchema,
  ProgramIdInputSchema,
  RenameChannelInputSchema,
  RenameDeviceInputSchema,
  RenameRoomInputSchema,
  RoomChannelsResultSchema,
  ServiceMessagesResultSchema,
  SetButtonEventsInputSchema,
  SetChannelConfigInputSchema,
  SetInstallModeInputSchema,
  SetProgramActiveInputSchema,
  SetRoomChannelsInputSchema,
  SetValueInputSchema,
  UpdateGroupInputSchema,
} from './ccu/ccu-schemas.js'

/**
 * Custom actions of the Homematic addon: the LAN scan behind the integration
 * form's CCU picker, and the CCU management page (`provider-homematic` admin
 * page). Reads are `query`; every CCU write is a `mutation` whose input carries
 * the operator's `confirmed` flag.
 */
/**
 * The library's diagnosis, passed through as it is: a read-only report for an
 * operator and an agent, shaped and documented by nodehomematic.
 */
const KeyEventDiagnosisSchema = z.custom<HmKeyEventDiagnosis>(
  (value) => typeof value === 'object' && value !== null,
)

export const homematicActions = defineCustomActions({
  discoverCcu: customAction(
    z.object({}),
    z.object({
      hosts: z.array(z.object({ host: z.string(), name: z.string(), id: z.string() })),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  listCcus: customAction(z.object({}), z.array(CcuListItemSchema), {
    kind: 'query',
    auth: 'admin',
  }),
  ccuOverview: customAction(IntegrationRefSchema, CcuOverviewSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  listServiceMessages: customAction(IntegrationRefSchema, ServiceMessagesResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  listCcuDevices: customAction(IntegrationRefSchema, CcuDevicesResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  listHeatingGroups: customAction(IntegrationRefSchema, HeatingOverviewSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  createHeatingGroup: customAction(CreateGroupInputSchema, HeatingGroupSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  updateHeatingGroup: customAction(UpdateGroupInputSchema, HeatingGroupSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  deleteHeatingGroup: customAction(DeleteGroupInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  ccuPairingStatus: customAction(IntegrationRefSchema, PairingStatusSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  setCcuInstallMode: customAction(SetInstallModeInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  deleteCcuDevice: customAction(DeleteCcuDeviceInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  getCcuDeviceConfig: customAction(DeviceRefSchema, DeviceConfigSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  setCcuChannelConfig: customAction(SetChannelConfigInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  acknowledgeServiceMessage: customAction(AcknowledgeInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  setButtonEvents: customAction(SetButtonEventsInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  listCcuLinks: customAction(IntegrationRefSchema, CcuLinksResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  createCcuLink: customAction(LinkProfileInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  setCcuLinkProfile: customAction(LinkProfileInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  deleteCcuLink: customAction(LinkRefInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  listCcuPrograms: customAction(IntegrationRefSchema, CcuProgramsResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  runCcuProgram: customAction(ProgramIdInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  setCcuProgramActive: customAction(SetProgramActiveInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  deleteCcuProgram: customAction(ProgramIdInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  ensureCcuKeyEventProgram: customAction(EnsureKeyEventProgramInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  renameCcuDevice: customAction(RenameDeviceInputSchema, DeviceRenameResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  renameCcuChannel: customAction(RenameChannelInputSchema, NamedObjectSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  listCcuRooms: customAction(IntegrationRefSchema, CcuRoomsResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  createCcuRoom: customAction(CreateRoomInputSchema, CcuRoomSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  renameCcuRoom: customAction(RenameRoomInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  deleteCcuRoom: customAction(DeleteRoomInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  setCcuRoomChannels: customAction(SetRoomChannelsInputSchema, RoomChannelsResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  getCcuDeviceState: customAction(DeviceRefSchema, CcuDeviceStateSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  diagnoseCcuKeyEvents: customAction(DeviceRefSchema, KeyEventDiagnosisSchema, {
    kind: 'query',
    auth: 'admin',
  }),
  setCcuValue: customAction(SetValueInputSchema, OkResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type HomematicActions = typeof homematicActions
