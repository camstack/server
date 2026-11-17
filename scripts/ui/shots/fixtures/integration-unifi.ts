/**
 * The create-integration wizard for UniFi Network (the real connection form) and RTSP (a
 * provider that declares no connection test). Invented; no controller is reached.
 */
import { buildConnectionFormSchema } from '../../../../packages/addon-provider-unifi/src/config'
import { defineFixtures } from './_define'

const tile = (addonId: string, name: string, canTest: boolean) => ({
  addonId,
  name,
  description: `${name} integration`,
  iconUrl: null,
  color: 'primary',
  instanceMode: 'multi',
  mode: 'account' as const,
  discoveryMode: 'manual',
  kind: 'device-provider' as const,
  brokerKind: null,
  supportsLocationImport: false,
  canTest,
  canAdd: true,
  existingInstances: [],
})

export default defineFixtures({
  area: 'integration-unifi',
  description: 'UniFi (testable) and RTSP (no test) in the create-integration wizard',
  handlers: {
    'integrations.getAvailableTypes': [
      tile('provider-unifi', 'UniFi Network', true),
      tile('provider-rtsp', 'RTSP', false),
    ],
    'integrations.list': [],
    'auth.listLoginMethods': [],
    'integrationInstances.instanceFormSchema': (input: unknown) => {
      const addonId =
        input !== null && typeof input === 'object' && 'addonId' in input
          ? input.addonId
          : undefined
      if (addonId === 'provider-unifi') return buildConnectionFormSchema()
      if (addonId === 'provider-rtsp')
        return {
          sections: [
            {
              id: 'rtsp',
              title: 'RTSP',
              columns: 1,
              fields: [{ type: 'text', key: 'host', label: 'Host', value: '' }],
            },
          ],
        }
      return null
    },
  },
})
