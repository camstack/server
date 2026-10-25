/**
 * Two account providers so the create-integration form can be opened with an
 * empty name. Invented; the form is the shared one every provider uses.
 */
import { defineFixtures } from './_define'

const account = (addonId: string, name: string) => ({
  addonId,
  name,
  description: `${name} account`,
  iconUrl: null,
  color: 'primary',
  instanceMode: 'multi',
  mode: 'account' as const,
  discoveryMode: 'manual',
  kind: 'device-provider' as const,
  brokerKind: null,
  supportsLocationImport: false,
  canTest: false,
  canAdd: true,
  existingInstances: [],
})

function schema(id: string, title: string, key: string, label: string) {
  return {
    sections: [
      {
        id,
        title,
        columns: 1,
        fields: [{ type: 'text', key, label, value: '' }],
      },
    ],
  }
}

export default defineFixtures({
  area: 'integration-form',
  description: 'RTSP and Wyze as account integrations, for the empty-name create form',
  handlers: {
    'integrations.getAvailableTypes': [
      account('provider-rtsp', 'RTSP'),
      account('provider-wyze', 'Wyze'),
    ],
    'integrations.list': [],
    'auth.listLoginMethods': [],
    'addonSettings.getGlobalSettings': (input: { addonId?: string }) => {
      if (input.addonId === 'provider-rtsp') return schema('rtsp', 'RTSP', 'host', 'Host')
      if (input.addonId === 'provider-wyze') return schema('wyze', 'Wyze', 'email', 'Email')
      return null
    },
  },
})
