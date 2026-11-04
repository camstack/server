/**
 * The Logs → Destinations list with Loki declaring two kinds, a status label, a last-checked time
 * and restore-by-old-id (the P2 fields of `integration-instances`). Use instead of
 * `provider-instances-loki-multi` (`--fixtures provider-instances-kinds,logs`). Invented data.
 */
import { defineFixtures } from './_define'
import base from './provider-instances-loki-multi'

type ByAddon = (i: { addonId: string }) => unknown

export default defineFixtures({
  area: 'provider-instances-kinds',
  description: 'provider-instances-loki-multi with kinds, status labels and restore id',
  handlers: {
    ...base.handlers,
    'integrationInstances.describe': (i: { addonId: string }) =>
      i.addonId === 'loki-logging'
        ? {
            instanceMode: 'multiple',
            kind: 'destination',
            canTest: true,
            allowRestoreId: true,
            kinds: [
              { id: 'push', label: 'Push API' },
              {
                id: 'gateway',
                label: 'Gateway',
                connectPath: '/addon/loki-logging/connect/{{brokerId}}',
              },
            ],
          }
        : (base.handlers['integrationInstances.describe'] as ByAddon)(i),
    'integrationInstances.listInstances': (i: { addonId: string }) =>
      i.addonId === 'loki-logging'
        ? [
            {
              id: 'loki-logging',
              name: 'Loki prod',
              configured: true,
              enabled: true,
              kind: 'push',
              status: { state: 'ok', label: 'Receiving' },
              lastCheckedAt: 1_793_000_000_000,
              formValues: { url: 'http://loki.example.com:3100', job: 'camstack' },
            },
            {
              id: 'inst-4c1d9e07',
              name: 'Loki staging',
              configured: true,
              enabled: true,
              kind: 'gateway',
              status: { state: 'error', label: 'Token expired', detail: 'Sign in again' },
              lastCheckedAt: 1_793_000_300_000,
              formValues: { url: 'http://loki-stg.example.com:3100', job: 'camstack-stg' },
            },
          ]
        : (base.handlers['integrationInstances.listInstances'] as ByAddon)(i),
  },
})
