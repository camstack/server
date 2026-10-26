/**
 * Matter integration detail with the add-device flow open. Invented ids only.
 * The pairing code is the Matter spec's example manual code shape (11 digits),
 * not a code from a real device.
 */
import { defineFixtures } from './_define'

const MATTER = {
  id: 'int_matter',
  addonId: 'matter-broker',
  name: 'Matter',
  enabled: true,
  processState: 'running',
  info: {},
}

export default defineFixtures({
  area: 'matter-add',
  description: 'Add a Matter device from a Home Assistant share code',
  handlers: {
    'integrations.get': MATTER,
    'integrations.list': [MATTER],
    'integrations.getAvailableTypes': [
      {
        addonId: 'matter-broker',
        name: 'Matter',
        description: 'Matter fabric',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'unique',
        mode: 'broker',
        discoveryMode: 'manual',
        kind: 'device-adoption',
        brokerKind: 'matter',
        supportsLocationImport: false,
        canTest: false,
        canAdd: true,
        existingInstances: [{ id: 'int_matter', name: 'Matter' }],
      },
    ],
    'deviceManager.listAll': [],
    'deviceManager.discoveryProviders': { providers: [] },
    'addonSettings.getGlobalSettings': null,
    'addonSettings.getIntegrationSettings': null,
    'deviceManager.adoptionListCandidateFilters': {
      filters: [{ id: 'devices', label: 'Devices', isDefault: true }],
    },
    'deviceManager.adoptionListCandidates': {
      candidates: [],
      totalCount: 0,
      page: 1,
      pageSize: 20000,
    },
    'broker.list': [
      {
        id: 'matter_001',
        addonId: 'matter-broker',
        name: 'Home fabric',
        kind: 'matter',
        status: 'connected',
        info: { nodeCount: 0 },
        lastCheckedAt: null,
        error: null,
      },
    ],
    'broker.getState': {
      phase: 'discovering',
      failure: null,
      message: null,
    },
    'auth.listLoginMethods': [],
  },
})
