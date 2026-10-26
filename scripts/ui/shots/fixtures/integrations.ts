/**
 * Integrations list with a Bosch SHC controller proposed by network scan.
 * Invented address (192.0.2.0/24). The modal opens from the page's Scan button.
 */
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'integrations',
  description: 'Integrations page with a Bosch SHC scan proposal',
  handlers: {
    'integrations.list': [
      {
        id: 'int_reolink',
        addonId: 'provider-reolink',
        name: 'Reolink',
        enabled: true,
        processState: 'running',
      },
    ],
    'deviceManager.listAll': [],
    'mut:deviceManager.discoverAllProviders': {
      groups: [
        {
          addonId: 'bosch-shc',
          label: 'Bosch SHC',
          error: null,
          candidates: [
            {
              stableId: 'bosch-shc:shc0123',
              type: 'hub',
              suggestedName: 'Bosch SHC [lab]',
              prefilledConfig: { host: '192.0.2.20', setupIntegration: true },
            },
          ],
        },
      ],
    },
    'integrations.getAvailableTypes': [
      {
        addonId: 'bosch-shc',
        name: 'Bosch SHC',
        description: 'Smart Home Controller',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'multiple',
        mode: 'account',
        discoveryMode: 'manual',
        kind: 'device-provider',
        brokerKind: null,
        supportsLocationImport: false,
        canTest: false,
        canAdd: true,
        existingInstances: [],
      },
    ],
    'auth.listLoginMethods': [],
  },
})
