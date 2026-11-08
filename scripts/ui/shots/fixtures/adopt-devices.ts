/**
 * Integration detail with the adopt-devices dialog open (`?add=1`): a
 * device-adoption addon with a mix of short and one very long candidate name.
 * Invented data only.
 */
import { defineFixtures } from './_define'

const HOME = {
  id: 'int_home',
  addonId: 'home-bridge',
  name: 'Home Bridge',
  enabled: true,
  processState: 'running',
  info: {},
}

function candidate(id: string, name: string, type: string, adopted = false, parent?: string) {
  return {
    childNativeId: id,
    name,
    type,
    status: 'online',
    metadata: {},
    alreadyAdopted: adopted,
    adoptedDeviceId: adopted ? 7 : null,
    capabilities: [],
    children: [],
    ...(parent !== undefined ? { parentStableId: parent } : {}),
  }
}

const CANDIDATES = [
  candidate('dev:0', 'Hue Bridge', 'hub'),
  candidate('dev:1', 'Kitchen Light', 'light', false, 'dev:0'),
  candidate(
    'dev:2',
    'Upstairs hallway motion and temperature sensor near the guest bedroom door (north wing, second floor)',
    'sensor',
  ),
  candidate('dev:3', 'Garage Door', 'cover'),
  candidate('dev:4', 'Porch Camera', 'camera', true),
  candidate('dev:5', 'Living Room Thermostat', 'climate'),
  candidate('alexa:G0014D060156024W', 'Echo Flex Giardino', 'speaker'),
  candidate(
    'alexa:76b7a6b8c1d24e0f9a3b5c7d8e9f0a1b',
    "roberta's Voice in a can for Apple Watch",
    'speaker',
  ),
]

export default defineFixtures({
  area: 'adopt-devices',
  description: 'Adopt devices dialog with a very long candidate name',
  handlers: {
    'integrations.get': HOME,
    'integrations.list': [HOME],
    'integrations.getAvailableTypes': [
      {
        addonId: 'home-bridge',
        name: 'Home Bridge',
        description: 'Adopt devices from a bridge',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'unique',
        mode: 'standalone',
        discoveryMode: 'manual',
        kind: 'device-adoption',
        brokerKind: null,
        supportsLocationImport: false,
        canTest: false,
        canAdd: true,
        existingInstances: [{ id: 'int_home', name: 'Home Bridge' }],
      },
    ],
    'deviceManager.listAll': [],
    'deviceManager.discoveryProviders': { providers: [] },
    'deviceManager.adoptionListCandidateFilters': {
      filters: [{ id: 'devices', label: 'Devices', isDefault: true }],
    },
    'deviceManager.adoptionListCandidates': {
      candidates: CANDIDATES,
      totalCount: CANDIDATES.length,
      page: 1,
      pageSize: 20000,
    },
    'deviceManager.providerCreationType': { deviceType: null },
    'integrationInstances.instanceFormSchema': { sections: [] },
    'preferences.get': null,
    'auth.listLoginMethods': [],
  },
})
