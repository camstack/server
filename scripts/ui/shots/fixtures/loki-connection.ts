/**
 * Loki as a connection integration: its page (`/integrations/loki-logging`) holds the
 * connection settings and no device list; the Logging page links to it. Invented data.
 */
import { defineFixtures } from './_define'

const ADDON = 'loki-logging'

const FORM = {
  sections: [
    {
      id: 'loki-logging',
      title: 'Loki',
      columns: 2,
      fields: [
        { type: 'text', key: 'url', label: 'Loki URL', value: 'http://loki.example.com:3100' },
        { type: 'text', key: 'job', label: 'Job label', value: 'camstack' },
        { type: 'text', key: 'username', label: 'Username', value: 'camstack' },
        { type: 'password', key: 'password', label: 'Password', value: '' },
      ],
    },
  ],
}

export default defineFixtures({
  area: 'loki-connection',
  description: 'Loki as a connection integration, plus the Logging destinations list',
  handlers: {
    'integrations.list': [
      { id: 'int_0007', addonId: ADDON, name: 'Loki', enabled: true, processState: 'running' },
    ],
    'integrations.get': {
      id: 'int_0007',
      addonId: ADDON,
      name: 'Loki',
      enabled: true,
      processState: 'running',
    },
    'integrations.getAvailableTypes': [
      {
        addonId: ADDON,
        name: 'Loki Logging',
        description: 'Ship logs to a Grafana Loki instance',
        iconUrl: null,
        color: 'primary',
        instanceMode: 'unique',
        mode: 'standalone',
        discoveryMode: 'manual',
        kind: 'connection',
        brokerKind: null,
        supportsLocationImport: false,
        canTest: true,
        canAdd: true,
        existingInstances: ['int_0007'],
      },
    ],
    'integrations.getSettings': { url: 'http://loki.example.com:3100' },
    'addonSettings.getIntegrationFormSchema': FORM,
    'deviceManager.listAll': [],
    'addons.listCapabilityProviders': [
      { addonId: ADDON, capName: 'log-destination', isActive: true },
    ],
  },
})
