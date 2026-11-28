/**
 * Zigbee2MQTT integrations as `integration-instances` (D1007): one `connections` record per
 * integration, keyed by the registry id, holding the connection to ONE Zigbee2MQTT system. The
 * token is a secret by TYPE; the records door keeps it in the keychain. The Gateway device is not
 * part of the record: it is a device OF the integration, adopted from it.
 */
import {
  type ConfigSection,
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  RecordIntegrationInstances,
  type RecordsAccess,
} from '@dominevo/types'
import { z } from 'zod'
import { Z2M_PERMIT_JOIN_DEFAULT_S } from './z2m-actions.js'

export const Z2M_DEFAULT_PORT = 8080
const Z2M_ADDON_ID = 'provider-zigbee-z2m'

export const ProviderZigbeeZ2mConnectionsKind = defineEntryKind('connections', {
  title: 'Zigbee2MQTT integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    /** The frontend `auth_token`, when the server asks for one; a secret by type, kept in the keychain. */
    token: z.string().optional().meta({ secret: true }),
  }),
  writeTrigger: 'an operator adds, edits or removes a Zigbee2MQTT integration',
})
export type ProviderZigbeeZ2mConnectionBody = z.infer<
  typeof ProviderZigbeeZ2mConnectionsKind.schema
>

/** Every record kind this addon declares, keyed by its name. */
export const ProviderZigbeeZ2mRecordKinds = {
  connections: ProviderZigbeeZ2mConnectionsKind,
} as const

/** What every action button of an integration's form sends along. */
type ActionParams = {
  readonly instanceId: string
}

function managementSection(params: ActionParams): ConfigSection {
  return {
    id: 'z2m-management',
    title: 'Network management',
    columns: 1,
    fields: [
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__permit-join',
        label: 'Allow new devices',
        description:
          'Opens the network so a device in pairing mode can join, then closes it on its own. Enter 0 to close it now.',
        buttonLabel: 'Allow joining…',
        action: 'permitJoin',
        variant: 'default',
        prompt: {
          param: 'seconds',
          title: 'Allow new devices',
          message: 'For how many seconds (1 to 254)? 0 closes the network.',
          placeholder: String(Z2M_PERMIT_JOIN_DEFAULT_S),
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__rename-device',
        label: 'Rename a device',
        description:
          'Renames the device on the Zigbee2MQTT server; its Dominevo device keeps its identity.',
        buttonLabel: 'Rename…',
        action: 'renameDevice',
        variant: 'default',
        prompt: {
          param: 'rename',
          title: 'Rename a device',
          message: 'Write: current name -> new name',
          placeholder: 'door_front -> front door',
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__remove-device',
        label: 'Remove a device',
        description: 'Removes the device from the network. It has to be paired again to come back.',
        buttonLabel: 'Remove…',
        action: 'removeDevice',
        variant: 'danger',
        prompt: {
          param: 'device',
          title: 'Remove a device',
          message: 'The device name or IEEE address.',
          placeholder: 'door_front',
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: { ...params, force: true },
        key: '__remove-device-force',
        label: 'Force remove a device',
        description:
          'For a device that no longer answers: it is dropped from the server even though the device did not confirm.',
        buttonLabel: 'Force remove…',
        action: 'removeDevice',
        variant: 'danger',
        prompt: {
          param: 'device',
          title: 'Force remove a device',
          message: 'The device name or IEEE address.',
          placeholder: 'door_front',
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__check-update',
        label: 'Check a device for firmware',
        description:
          'Asks the server whether a firmware image is available. A battery device is only asked when it next wakes.',
        buttonLabel: 'Check…',
        action: 'checkDeviceUpdate',
        variant: 'default',
        prompt: {
          param: 'device',
          title: 'Check for firmware',
          message: 'The device name or IEEE address.',
          placeholder: 'door_front',
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__update-device',
        label: 'Update a device firmware',
        description:
          'Starts the firmware update. It runs for minutes and a sleepy device may need to be woken; do not power it off meanwhile.',
        buttonLabel: 'Update…',
        action: 'updateDevice',
        variant: 'danger',
        prompt: {
          param: 'device',
          title: 'Update firmware',
          message: 'The device name or IEEE address.',
          placeholder: 'door_front',
        },
        successMessage: '{message}',
      },
      {
        type: 'addon-action-button',
        addonId: Z2M_ADDON_ID,
        paramsStatic: params,
        key: '__restart-bridge',
        label: 'Restart Zigbee2MQTT',
        description: 'Restarts the server process. The network is unavailable for a moment.',
        buttonLabel: 'Restart now',
        action: 'restartBridge',
        variant: 'danger',
        confirmMessage: 'Restart Zigbee2MQTT? Every device is unreachable until it is back.',
        successMessage: '{message}',
      },
    ],
  }
}

export function buildProviderZigbeeZ2mConnectionForm(id: string | null = null): ConfigUISchema {
  const connection: ConfigSection = {
    id: 'connection',
    title: 'Connection',
    columns: 1,
    fields: [
      { type: 'text', key: 'name', label: 'Name' },
      { type: 'text', key: 'host', label: 'Host' },
      {
        type: 'number',
        key: 'port',
        label: 'Frontend port',
        default: Z2M_DEFAULT_PORT,
      },
      {
        type: 'boolean',
        key: 'tls',
        label: 'Use TLS (wss)',
        default: false,
      },
      {
        type: 'password',
        key: 'token',
        label: 'Auth token (optional)',
        showToggle: true,
      },
    ],
  }
  return {
    sections: id === null ? [connection] : [connection, managementSection({ instanceId: id })],
  }
}

export interface ProviderZigbeeZ2mInstanceDeps {
  /** Re-apply the runtime from the records after a create, update, enable or delete. */
  readonly onChanged: () => Promise<void>
  /** Probe the remote with the (possibly unsaved) values; a failed probe is not a pass. */
  readonly probe: (
    values: Readonly<Record<string, unknown>>,
  ) => Promise<IntegrationTestConnectionResult>
}

export function buildProviderZigbeeZ2mInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: ProviderZigbeeZ2mInstanceDeps,
): RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody> {
  return new RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody>(
    records,
    ProviderZigbeeZ2mConnectionsKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'account', scopedToInstance: true },
        instanceMode: 'multiple',
        kind: 'server',
        canTest: true,
        // The one kind this provider serves; its functionCap is the cap an instance of it feeds.
        kinds: [
          {
            id: 'server',
            label: 'Zigbee2MQTT',
            functionCap: 'device-provider',
            role: 'devices',
          },
        ],
      },
      formSchema: (id) => buildProviderZigbeeZ2mConnectionForm(id),
      initialBody: (name): ProviderZigbeeZ2mConnectionBody => ({ name }),
      configured: (body) => (body.host ?? '').length > 0,
      onChanged: () => deps.onChanged(),
      test: ({ values }) => deps.probe(values),
    },
  )
}
