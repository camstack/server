/**
 * The Model Studio page as an app in the shell drawer (`app-source`, D1096,
 * planning#734). Admin-only: the aggregator drops it for any other caller,
 * server side. The entry is the same addon page the standalone admin mounts at
 * `/addon/model-studio`.
 */
import type { AppDeclaration, IAppSourceProvider } from '@dominevo/types'

export const MODEL_STUDIO_APP_ID = 'model-studio'

export function buildModelStudioApp(): AppDeclaration {
  return {
    id: MODEL_STUDIO_APP_ID,
    label: { key: 'apps.modelStudio', fallback: 'Model Studio' },
    icon: 'boxes',
    order: 31,
    entry: { kind: 'addon-page', pageId: MODEL_STUDIO_APP_ID },
    reach: { kind: 'hub' },
    adminOnly: true,
    nav: [
      {
        id: MODEL_STUDIO_APP_ID,
        label: null,
        items: [
          {
            id: MODEL_STUDIO_APP_ID,
            label: { key: 'apps.modelStudio', fallback: 'Model Studio' },
            icon: 'boxes',
            path: '/addon/model-studio',
          },
        ],
      },
    ],
    takesSharedSearch: false,
    settings: null,
  }
}

export function createModelStudioAppSourceProvider(): IAppSourceProvider {
  return { listApps: async () => [buildModelStudioApp()] }
}
