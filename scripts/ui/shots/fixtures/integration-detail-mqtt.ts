/**
 * An integration's detail page with a populated device table (`/integrations/provider-homeassistant`):
 * the "MQTT Discovery" account with contact sensors, a number and a choice control and two
 * heaters, each row carrying its inline control, the open-page arrow, the delete action and the
 * status dot. The phone shot is the table's narrow-width reference. Invented data.
 */
import { defineFixtures } from './_define'
import inlineControls from './devices-inline-controls'

const MQTT = {
  id: 'int_ha',
  addonId: 'provider-homeassistant',
  name: 'MQTT Discovery',
  enabled: true,
  processState: 'running',
  info: {},
}

export default defineFixtures({
  area: 'integration-detail-mqtt',
  description: 'One integration detail page whose device table has rows with inline controls',
  handlers: {
    ...inlineControls.handlers,
    'integrations.get': MQTT,
    'integrations.list': [MQTT],
    'integrations.getAvailableTypes': [
      {
        addonId: 'provider-homeassistant',
        name: 'MQTT Discovery',
        description: 'Devices announced over MQTT',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'multiple',
        mode: 'account',
        discoveryMode: 'manual',
        kind: 'device-provider',
        brokerKind: null,
        supportsLocationImport: false,
        canTest: true,
        canAdd: true,
        existingInstances: [{ id: 'int_ha', name: 'MQTT Discovery' }],
      },
    ],
    'integrationInstances.describe': {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [{ id: 'mqtt', label: 'MQTT Discovery', functionCap: 'device-provider' }],
    },
    'integrationInstances.listInstances': [],
  },
})
