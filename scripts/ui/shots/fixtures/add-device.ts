/**
 * Integration detail with the unified Add device modal open (`?add=1`): a
 * device-provider integration with a network-found list (one board that needs
 * its encryption key) and a manual creation form. Invented data only.
 */
import { defineFixtures } from './_define'

const ESP = {
  id: 'int_esp',
  addonId: 'provider-esphome',
  name: 'ESPHome boards',
  enabled: true,
  processState: 'running',
  info: {},
}

function hit(stableId: string, name: string, host: string, extra: Record<string, unknown> = {}) {
  return {
    stableId,
    type: 'container',
    suggestedName: name,
    prefilledConfig: { host, port: 6053, name },
    ...extra,
  }
}

const PROPOSALS = [
  {
    id: 'p1',
    addonId: 'provider-esphome',
    candidate: hit('esphome-attic-relay', 'attic-relay', '192.0.2.31', {
      needsParams: ['encryptionKey'],
    }),
  },
  {
    id: 'p2',
    addonId: 'provider-esphome',
    candidate: hit('esphome-porch-light', 'porch-light', '192.0.2.32'),
  },
  {
    id: 'p3',
    addonId: 'provider-esphome',
    candidate: hit('esphome-garage-door', 'garage-door', '192.0.2.33', {
      alreadyOnboarded: true,
      onboardedDeviceId: 9,
      onboardedName: 'Garage door',
    }),
  },
]

export default defineFixtures({
  area: 'add-device',
  description: 'Add device modal: network candidates (with a parameter step) and manual form',
  handlers: {
    'integrations.get': ESP,
    'integrations.list': [ESP],
    'integrations.getAvailableTypes': [
      {
        addonId: 'provider-esphome',
        name: 'ESPHome',
        description: 'ESPHome boards over the native API',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'multiple',
        mode: 'standalone',
        discoveryMode: 'manual',
        kind: 'device-provider',
        brokerKind: null,
        supportsLocationImport: false,
        canTest: false,
        canAdd: true,
        existingInstances: [{ id: 'int_esp', name: 'ESPHome boards' }],
      },
    ],
    'deviceManager.listAll': [],
    'deviceManager.discoveryProviders': {
      providers: [{ addonId: 'provider-esphome', label: 'ESPHome' }],
    },
    'deviceManager.listDiscoveryProposals': { proposals: PROPOSALS },
    'deviceManager.providerDiscoveryParamsSchema': null,
    'deviceManager.adoptionListCandidates': {
      candidates: [],
      totalCount: 0,
      page: 1,
      pageSize: 500,
    },
    'deviceManager.providerCreationType': { deviceType: 'container' },
    'deviceManager.getCreationSchema': {
      sections: [
        {
          id: 'board',
          title: 'Board',
          columns: 1,
          fields: [
            { type: 'text', key: 'host', label: 'Host / IP', required: true },
            { type: 'number', key: 'port', label: 'API port', default: 6053 },
            { type: 'text', key: 'name', label: 'Name' },
            {
              type: 'password',
              key: 'encryptionKey',
              label: 'API encryption key',
              description:
                'Only for an encrypted board. It is in the board YAML under api: encryption: key:.',
            },
          ],
        },
      ],
    },
    'integrationInstances.instanceFormSchema': { sections: [] },
    'preferences.get': null,
    'localNetwork.getScanSubnets': { subnets: [] },
    'addonSettings.getGlobalSettings': null,
    'addonSettings.getIntegrationSettings': null,
    'auth.listLoginMethods': [],
  },
})
