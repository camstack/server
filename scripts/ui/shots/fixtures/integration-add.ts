/**
 * Add integration picker: Bosch SHC uses the real connection schema. The
 * other tiles cover the shapes that share that form (plain text, a select
 * that waits for a token, a select that loads immediately, a standalone
 * create). Invented hosts only.
 */
import { buildConnectionFormSchema } from '../../../../packages/addon-provider-bosch/src/shc/config'
import { defineFixtures } from './_define'

interface ProviderTile {
  readonly addonId: string
  readonly name: string
  readonly description: string
  readonly iconUrl: null
  readonly color: string
  readonly instanceMode: 'multi'
  readonly mode: 'account' | 'standalone'
  readonly discoveryMode: 'manual'
  readonly kind: 'device-provider'
  readonly brokerKind: null
  readonly supportsLocationImport: false
  readonly canTest: false
  readonly canAdd: true
  readonly existingInstances: readonly []
}

function tile(addonId: string, name: string, mode: 'account' | 'standalone'): ProviderTile {
  return {
    addonId,
    name,
    description: `${name} account`,
    iconUrl: null,
    color: 'primary',
    instanceMode: 'multi',
    mode,
    discoveryMode: 'manual',
    kind: 'device-provider',
    brokerKind: null,
    supportsLocationImport: false,
    canTest: false,
    canAdd: true,
    existingInstances: [],
  }
}

function textSchema(id: string, title: string, key: string, label: string) {
  return {
    sections: [
      {
        id,
        title,
        columns: 1 as const,
        fields: [{ type: 'text' as const, key, label, value: '' }],
      },
    ],
  }
}

const zoneSchema = {
  sections: [
    {
      id: 'tunnel',
      title: 'Tunnel',
      columns: 1 as const,
      fields: [
        { type: 'password' as const, key: 'customApiToken', label: 'API token', value: '' },
        {
          type: 'addon-action-select' as const,
          addonId: 'cloudflare-tunnel',
          key: 'customZoneId',
          label: 'Zone',
          action: 'listZones',
          paramsFromForm: { token: 'customApiToken' },
          mapOption: { value: 'id', label: 'name' },
          emptyParamsMessage: 'Paste your API token above first.',
        },
      ],
    },
  ],
}

const addressSchema = {
  sections: [
    {
      id: 'address',
      title: 'Address',
      columns: 1 as const,
      fields: [
        {
          type: 'addon-action-select' as const,
          addonId: 'address-picker',
          key: 'publicHubUrl',
          label: 'External address',
          action: 'listExternalAddresses',
          mapOption: { value: 'value', label: 'label' },
          emptyResultsMessage: 'No external HTTPS address detected.',
        },
      ],
    },
  ],
}

const SCHEMAS: Readonly<Record<string, unknown>> = {
  'bosch-shc': buildConnectionFormSchema(),
  'provider-wyze': textSchema('wyze', 'Wyze', 'email', 'Email'),
  'provider-rtsp': textSchema('rtsp', 'RTSP', 'host', 'Host'),
  'provider-dreo': textSchema('dreo', 'Dreo', 'email', 'Email'),
  'provider-tuya': textSchema('tuya', 'Tuya', 'accessId', 'Access id'),
  'provider-dreame': textSchema('dreame', 'Dreame', 'email', 'Email'),
  'cloudflare-tunnel': zoneSchema,
  'address-picker': addressSchema,
}

export default defineFixtures({
  area: 'integration-add',
  description: 'Add integration picker, including the Bosch SHC connection schema',
  handlers: {
    'integrations.getAvailableTypes': [
      tile('bosch-shc', 'Bosch SHC', 'account'),
      tile('provider-wyze', 'Wyze', 'account'),
      tile('provider-rtsp', 'RTSP', 'account'),
      tile('provider-dreo', 'Dreo', 'account'),
      tile('provider-tuya', 'Tuya', 'account'),
      tile('provider-dreame', 'Dreame', 'account'),
      tile('cloudflare-tunnel', 'Cloudflare', 'account'),
      tile('address-picker', 'External address', 'account'),
      tile('provider-reolink', 'Reolink', 'standalone'),
    ],
    'integrations.list': [],
    'auth.listLoginMethods': [],
    'addonSettings.getGlobalSettings': (input: unknown) => {
      const addonId =
        input !== null && typeof input === 'object' && 'addonId' in input
          ? input.addonId
          : undefined
      if (typeof addonId !== 'string') return null
      return SCHEMAS[addonId] ?? null
    },
    'mut:addons.custom': (input: unknown) => {
      const action =
        input !== null && typeof input === 'object' && 'action' in input ? input.action : undefined
      if (action === 'discoverController') {
        return { controllers: [{ host: '192.0.2.20', name: 'Lab controller' }] }
      }
      if (action === 'listExternalAddresses') {
        return { addresses: [{ value: 'https://hub.example.com', label: 'Hub' }] }
      }
      if (action === 'listZones') {
        return { zones: [{ id: 'zone-1', name: 'example.com' }] }
      }
      return { ok: true }
    },
    'mut:integrations.create': { id: 'int-new', name: 'New' },
  },
})
