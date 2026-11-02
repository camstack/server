/**
 * Loki's connection on the Logging page: an `integration-instances` record edited in the
 * destination's Settings section, with the password as a "set" view. The Integrations page lists
 * only device-bringing integrations, never Loki. Invented data.
 */
import { defineFixtures } from './_define'

const ADDON = 'loki-logging'

const FORM = {
  sections: [
    {
      id: 'loki-logging',
      title: 'Loki',
      description: 'Ship this node’s logs to a Grafana Loki instance.',
      columns: 2,
      fields: [
        { type: 'text', key: 'url', label: 'Loki URL', default: '' },
        { type: 'text', key: 'job', label: 'Job label', default: 'camstack' },
        { type: 'text', key: 'username', label: 'Username', default: '' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

export default defineFixtures({
  area: 'loki-connection',
  description: 'Loki connection record on the Logging page; the Integrations list without it',
  handlers: {
    'integrations.list': [],
    'integrations.getAvailableTypes': [],
    'integrationInstances.describe': { instanceMode: 'single', kind: 'destination', canTest: true },
    'integrationInstances.instanceFormSchema': FORM,
    'integrationInstances.listInstances': [
      {
        id: 'int_0007',
        name: 'Loki',
        configured: true,
        formValues: {
          url: 'http://loki.example.com:3100',
          job: 'camstack',
          username: 'camstack',
          password: { $secret: 'ref', v: 1, set: true },
        },
      },
    ],
    'deviceManager.listAll': [],
    'addons.listCapabilityProviders': (i: { capName: string }) =>
      i.capName === 'log-destination' || i.capName === 'integration-instances'
        ? [{ addonId: ADDON, capName: i.capName, isActive: true }]
        : [],
  },
})
