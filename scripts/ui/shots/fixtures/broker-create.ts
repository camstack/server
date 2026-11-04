/**
 * Creating a broker: the integration wizard's broker step ("Create new…" opens
 * the broker dialog stacked over the wizard) and Connectivity -> Brokers ->
 * Add. The kind has an interactive sign-in and the Alexa connection schema,
 * the real one from the addon, so the dialog shows what an operator sees.
 * Invented data only.
 *
 *   --route /integrations --fixtures broker-create
 *   --route "/system/integrations?tab=brokers&integration=import-alexa" --fixtures broker-create
 *   (also integration=provider-homeassistant and integration=matter-broker)
 *
 * The same page answers the old broker cap and `integration-instances`, so one fixture shoots
 * the before (legacy editor) and the after (the instances table and dialog).
 */
import { buildConnectionFormSchema } from '../../../../packages/addon-import-alexa/src/config'
import { defineFixtures } from './_define'

const PROVIDER = {
  addonId: 'import-alexa',
  kinds: [
    {
      kind: 'alexa',
      label: 'Alexa',
      signIn: {
        basePath: '/addon/import-alexa/login',
        methods: ['device-code', 'proxy'],
      },
    },
  ],
}

const KIND_FORMS: Record<string, unknown> = {
  'import-alexa': buildConnectionFormSchema(),
  'provider-homeassistant': {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'authKind',
            label: 'Authentication',
            default: 'long-lived',
            options: [
              { value: 'long-lived', label: 'Long-lived access token' },
              { value: 'supervisor', label: 'Supervisor token' },
            ],
          },
          { type: 'text', key: 'baseUrl', label: 'Base URL', default: '' },
          { type: 'password', key: 'accessToken', label: 'Access token' },
        ],
      },
    ],
  },
  'matter-broker': {
    sections: [
      {
        id: 'fabric',
        title: 'Fabric',
        columns: 1,
        fields: [
          { type: 'password', key: 'threadDataset', label: 'Thread dataset' },
          {
            type: 'text',
            key: 'wifiSsid',
            label: 'Wi-Fi network',
            default: '',
          },
          { type: 'password', key: 'wifiPassword', label: 'Wi-Fi password' },
        ],
      },
    ],
  },
}

const PROVIDERS = [
  PROVIDER,
  {
    addonId: 'provider-homeassistant',
    kinds: [{ kind: 'home-assistant', label: 'Home Assistant' }],
  },
  { addonId: 'matter-broker', kinds: [{ kind: 'matter', label: 'Matter' }] },
]

const DESCRIBE: Record<string, unknown> = {
  'import-alexa': {
    instanceMode: 'multiple',
    kind: 'account',
    canTest: false,
    mintsId: true,
    kinds: [
      {
        id: 'alexa',
        label: 'Alexa',
        signIn: {
          basePath: '/addon/import-alexa/login',
          methods: ['device-code', 'proxy'],
        },
      },
    ],
  },
  'provider-homeassistant': {
    instanceMode: 'multiple',
    kind: 'connection',
    canTest: false,
    mintsId: true,
    kinds: [{ id: 'home-assistant', label: 'Home Assistant' }],
  },
  'matter-broker': {
    instanceMode: 'multiple',
    kind: 'fabric',
    canTest: false,
    mintsId: true,
    kinds: [{ id: 'matter', label: 'Matter' }],
  },
}

const INSTANCES: Record<string, unknown[]> = {
  'import-alexa': [
    {
      id: 'alexa_001',
      name: 'Home Amazon',
      kind: 'alexa',
      configured: true,
      formValues: {
        amazonDomain: 'amazon.example',
        cookie: { $secret: 'x', v: 1, set: true },
      },
    },
  ],
  'provider-homeassistant': [],
  'matter-broker': [],
}

const manifestOf = (id: string, name: string) => ({
  manifest: {
    id,
    name,
    version: '1.2.3',
    packageName: `@camstack/addon-${id}`,
    packageVersion: '1.2.3',
    capabilities: ['broker', 'integration-instances'],
  },
  source: 'installed',
  installSource: 'npm',
  process: { pid: 4201, mode: 'forked', state: 'running' },
  hasBackup: false,
  health: null,
})

const TILE = {
  addonId: 'import-alexa',
  name: 'Alexa',
  description: 'Import the devices of an Amazon Alexa account',
  iconUrl: null,
  color: 'primary',
  instanceMode: 'multi',
  mode: 'broker',
  discoveryMode: 'manual',
  kind: 'device-provider',
  brokerKind: 'alexa',
  supportsLocationImport: false,
  canTest: false,
  canAdd: true,
  existingInstances: [],
}

export default defineFixtures({
  area: 'broker-create',
  description: 'Create a broker with an interactive sign-in, from the wizard and from Connectivity',
  handlers: {
    'integrations.getAvailableTypes': [TILE],
    'integrations.list': [],
    'auth.listLoginMethods': [],
    'addons.list': [
      manifestOf('import-alexa', 'Alexa'),
      manifestOf('provider-homeassistant', 'Home Assistant'),
      manifestOf('matter-broker', 'Matter'),
    ],
    'recordEntries.listEntryKinds': { kinds: [] },
    'broker.list': [],
    'broker.listProviders': PROVIDERS,
    'broker.getStatus': { brokerCount: 0, connectedCount: 0 },
    'broker.getSettingsSchema': buildConnectionFormSchema(),
    'integrationInstances.describe': (i: { addonId: string }) => DESCRIBE[i.addonId] ?? null,
    'integrationInstances.instanceFormSchema': (i: { addonId: string }) =>
      KIND_FORMS[i.addonId] ?? null,
    'integrationInstances.listInstances': (i: { addonId: string }) => INSTANCES[i.addonId] ?? [],
    'mut:integrationInstances.createInstance': { id: 'alexa_002' },
    'mut:integrationInstances.updateInstance': { ok: true },
    'broker.testSettings': { ok: true },
    'mut:broker.add': { id: 'alexa_001' },
  },
})

/**
 * The sign-in routes are plain `fetch` calls, not tRPC, so a shot that needs
 * the device code stubs them in the page first:
 *   --step "js:$(...)" with this expression, then click "Get a code".
 */
export const DEVICE_CODE_FETCH_STUB =
  "(window.__realFetch = window.fetch.bind(window), window.fetch = (url, init) => String(url).includes('/addon/import-alexa/login') ? Promise.resolve(new Response(JSON.stringify({ sessionId: 's1', userCode: 'KQ7X-4M2P', verificationUrl: 'https://www.amazon.example/code', expiresAt: Date.now() + 9 * 60000, phase: 'awaiting-code', error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : window.__realFetch(url, init), 'stubbed')"
