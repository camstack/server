import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import {
  AcknowledgeInputSchema,
  CcuDevicesResultSchema,
  CcuListItemSchema,
  CcuOverviewSchema,
  CreateGroupInputSchema,
  DeleteCcuDeviceInputSchema,
  DeviceConfigSchema,
  DeviceRefSchema,
  DeleteGroupInputSchema,
  HeatingGroupSchema,
  HeatingOverviewSchema,
  IntegrationRefSchema,
  OkResultSchema,
  PairingStatusSchema,
  SetChannelConfigInputSchema,
  SetInstallModeInputSchema,
  ServiceMessagesResultSchema,
  UpdateGroupInputSchema,
} from './ccu/ccu-schemas.js'

/**
 * Custom actions of the Homematic addon: the LAN scan behind the integration
 * form's CCU picker, and the CCU management page (`provider-homematic` admin
 * page). Reads are `query`; every CCU write is a `mutation` whose input carries
 * the operator's `confirmed` flag.
 */
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
})

export type HomematicActions = typeof homematicActions
