/**
 * Creating a broker: the integration wizard's broker step ("Create new…" opens
 * the broker dialog stacked over the wizard) and Connectivity -> Brokers ->
 * Add. The kind has an interactive sign-in and the Alexa connection schema,
 * the real one from the addon, so the dialog shows what an operator sees.
 * Invented data only.
 *
 *   --route /integrations --fixtures broker-create
 *   --route "/system/integrations?integration=import-alexa" --fixtures broker-create
 */
import { buildConnectionFormSchema } from '../../../../packages/addon-import-alexa/src/config'
import { defineFixtures } from './_define'

const PROVIDER = {
  addonId: 'import-alexa',
  kinds: [
    {
      kind: 'alexa',
      label: 'Alexa',
      signIn: { basePath: '/addon/import-alexa/login', methods: ['device-code', 'proxy'] },
    },
  ],
}

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
      {
        manifest: {
          id: 'import-alexa',
          name: 'Alexa',
          version: '1.2.3',
          packageName: '@camstack/addon-import-alexa',
          packageVersion: '1.2.3',
          capabilities: ['broker'],
        },
        source: 'installed',
        installSource: 'npm',
        process: { pid: 4201, mode: 'forked', state: 'running' },
        hasBackup: false,
        health: null,
      },
    ],
    'recordEntries.listEntryKinds': { kinds: [] },
    'broker.list': [],
    'broker.listProviders': [PROVIDER],
    'broker.getStatus': { brokerCount: 0, connectedCount: 0 },
    'broker.getSettingsSchema': buildConnectionFormSchema(),
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
