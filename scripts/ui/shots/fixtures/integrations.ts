/**
 * Integrations list with a network scan: a Bosch SHC controller proposal, a
 * gateway with two devices found behind it, and two selectable ESPHome-style
 * boards. Invented addresses (192.0.2.0/24, 198.51.100.0/24). The modal opens
 * from the page's Scan button.
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
              prefilledConfig: { host: '192.0.2.20' },
              setupIntegration: true,
            },
          ],
        },
        {
          addonId: 'provider-hue',
          label: 'Hue',
          error: null,
          candidates: [
            {
              stableId: 'hue:bridge-1',
              type: 'hub',
              suggestedName: 'Hue Bridge',
              prefilledConfig: { host: '192.0.2.41' },
              selectable: false,
            },
            {
              stableId: 'hue:lamp-hall',
              type: 'light',
              suggestedName: 'Hall lamp',
              prefilledConfig: {},
              parentStableId: 'hue:bridge-1',
            },
            {
              stableId: 'hue:lamp-desk',
              type: 'light',
              suggestedName: 'Desk lamp',
              prefilledConfig: {},
              parentStableId: 'hue:bridge-1',
            },
          ],
        },
        {
          addonId: 'provider-esphome',
          label: 'ESPHome',
          error: null,
          candidates: [
            {
              stableId: 'esphome:garage-node',
              type: 'sensor',
              suggestedName: 'garage-node',
              prefilledConfig: { host: '198.51.100.12' },
            },
            {
              stableId: 'esphome:attic-node',
              type: 'sensor',
              suggestedName: 'attic-node',
              prefilledConfig: { host: '198.51.100.13' },
            },
          ],
        },
      ],
    },
    'localNetwork.getScanSubnets': { subnets: ['198.51.100.0/24'] },
    'mut:localNetwork.setScanSubnets': (input: { subnets: string[] }) => ({
      subnets: input.subnets,
    }),
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
