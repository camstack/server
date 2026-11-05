/**
 * An integration's device list while a confirmed delete is still running: the
 * `deviceManager.remove` mutation never answers, so the row the operator just
 * deleted stays in its "Removing…" state. Drive it with
 * `--step 'click:button[aria-label="Delete device"]' --step 'click:role=button[name="Delete"]'`.
 * Names are invented.
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

const lamp = (id: number, name: string) => ({
  id,
  stableId: `home-bridge:lamp${id}`,
  addonId: 'home-bridge',
  type: 'light',
  name,
  online: true,
  disabled: false,
  parentDeviceId: null,
  integrationId: 'int_home',
})

export default defineFixtures({
  area: 'device-removal',
  description: 'Integration device list with a delete that has not finished',
  handlers: {
    'integrations.get': HOME,
    'integrations.list': [HOME],
    'integrations.getAvailableTypes': [
      {
        addonId: 'home-bridge',
        name: 'Home Bridge',
        description: 'Devices from a bridge',
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
    'deviceManager.listAll': [lamp(1, 'Hall lamp'), lamp(2, 'Kitchen lamp'), lamp(3, 'Porch lamp')],
    'deviceManager.discoveryProviders': { providers: [] },
    'mut:deviceManager.remove': { __hang: true },
  },
})
