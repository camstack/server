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
      signIn: { basePath: '/addon/import-alexa/login' },
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
