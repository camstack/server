/**
 * The Homematic CCU page as an app in the shell drawer (`app-source`, D1096,
 * planning#734). Admin-only: the aggregator drops it for any other caller,
 * server side. The entry is the same addon page the standalone admin mounts at
 * `/addon/homematic-ccu`.
 */
import type { AppDeclaration, IAppSourceProvider } from '@dominevo/types'

export const HOMEMATIC_APP_ID = 'homematic-ccu'

export function buildHomematicApp(): AppDeclaration {
  return {
    id: HOMEMATIC_APP_ID,
    label: { key: 'apps.homematicCcu', fallback: 'Homematic CCU' },
    icon: 'plug',
    order: 32,
    entry: { kind: 'addon-page', pageId: HOMEMATIC_APP_ID },
    reach: { kind: 'hub' },
    adminOnly: true,
    nav: [
      {
        id: HOMEMATIC_APP_ID,
        label: null,
        items: [
          {
            id: HOMEMATIC_APP_ID,
            label: { key: 'apps.homematicCcu', fallback: 'Homematic CCU' },
            icon: 'plug',
            path: '/addon/homematic-ccu',
          },
        ],
      },
    ],
    takesSharedSearch: false,
    settings: null,
  }
}

export function createHomematicAppSourceProvider(): IAppSourceProvider {
  return { listApps: async () => [buildHomematicApp()] }
}
