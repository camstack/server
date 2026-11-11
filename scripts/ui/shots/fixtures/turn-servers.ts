/**
 * Network -> TURN Servers: one `turn-provider` table (a static server record, invented data).
 */
import { defineFixtures } from './_define'

const FORM = {
  sections: [
    {
      id: 'tunnel',
      title: 'Tunnel',
      columns: 2,
      fields: [{ type: 'text', key: 'label', label: 'Label', default: '' }],
    },
  ],
}

export default defineFixtures({
  area: 'turn-servers',
  description: 'TURN Servers table with one static server',
  handlers: {
    'addons.listCapabilityProviders': (i: { capName: string }) => {
      if (i.capName === 'turn-provider') {
        return ['cloudflare', 'coturn'].map((addonId) => ({
          addonId,
          capName: i.capName,
          isActive: true,
        }))
      }
      if (i.capName === 'integration-instances') {
        return [{ addonId: 'coturn', capName: i.capName, isActive: true }]
      }
      return []
    },
    'integrationInstances.describe': { instanceMode: 'multiple', kind: 'turn', canTest: false },
    'integrationInstances.instanceFormSchema': FORM,
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'coturn'
        ? [
            {
              id: 'turn_001',
              name: 'turn.example.com',
              configured: true,
              formValues: { label: 'x' },
            },
          ]
        : [],
    'turnProvider.getTurnServers': [
      { urls: ['turn:203.0.113.7:3478'], username: 'u', credential: 'x' },
    ],
  },
})
