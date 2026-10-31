/**
 * Devices page header actions ("Add device", "Browse integrations") and the
 * Addons page filtered on integrations (`/system/addons?kind=integration`):
 * two installed integration types, one set up.
 */
import { defineFixtures } from './_define'

function type(addonId: string, name: string) {
  return {
    addonId,
    name,
    description: name,
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
  }
}

export default defineFixtures({
  area: 'devices-add',
  description: 'Integration types for the Add device picker and the integrations addon filter',
  handlers: {
    'integrations.getAvailableTypes': [type('reolink', 'Reolink'), type('homematic', 'Homematic')],
    'integrations.list': [
      {
        id: 'int_reolink',
        addonId: 'reolink',
        name: 'Reolink',
        enabled: true,
        info: {},
        createdAt: 0,
        updatedAt: 0,
        processState: 'running',
      },
    ],
    'deviceManager.listAll': [],
  },
})
