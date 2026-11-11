/**
 * An account integration's detail page while its addon is down: the switch is refused and says
 * why, in the words the instances table uses. Invented ids and hosts only.
 */
import { defineFixtures } from './_define'

const HM = {
  id: 'int_hm',
  addonId: 'provider-homematic',
  name: 'Homematic CCU',
  enabled: true,
  switchUnknown: true,
  processState: 'failed',
  info: {},
}

export default defineFixtures({
  area: 'integration-detail-stopped',
  description: 'One account integration whose addon is not running',
  handlers: {
    'integrations.get': HM,
    'integrations.list': [HM],
    'integrations.getAvailableTypes': [
      {
        addonId: 'provider-homematic',
        name: 'Homematic',
        description: 'Homematic CCU',
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
        existingInstances: [{ id: 'int_hm', name: 'Homematic CCU' }],
      },
    ],
    'integrationInstances.describe': {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [{ id: 'hm', label: 'Homematic', functionCap: 'device-provider' }],
    },
    'integrationInstances.instanceFormSchema': {
      sections: [
        {
          id: 'conn',
          title: 'Connection',
          columns: 1,
          fields: [{ type: 'text', key: 'host', label: 'Host' }],
        },
      ],
    },
    'integrationInstances.getInstance': {
      id: 'int_hm',
      name: 'Homematic CCU',
      kind: 'hm',
      enabled: true,
      configured: true,
      status: { state: 'ok', label: 'Connected' },
      formValues: { host: '192.0.2.40' },
    },
    'integrationInstances.listInstances': [],
    'deviceManager.listAll': [],
  },
})
