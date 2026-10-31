/**
 * Integrations page while a provider addon respawns: the device list answers
 * "provider not available". The page shows a reconnecting notice instead of an
 * error page.
 */
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'integrations-restarting',
  description: 'Integrations page while the provider addon restarts (transient list error)',
  handlers: {
    'integrations.list': [
      {
        id: 'int_homematic',
        addonId: 'provider-homematic',
        name: 'Homematic',
        enabled: true,
        processState: 'running',
      },
    ],
    'deviceManager.listAll': { __error: 'provider not available' },
  },
})
