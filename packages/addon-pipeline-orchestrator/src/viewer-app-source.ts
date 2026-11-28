/**
 * The Viewer app as the shell sees it (`app-source`, D1096). The pipeline
 * orchestrator already serves the viewer web SPA (`viewer-ui`), so it also
 * declares the app. The viewer's own tabs (cameras, grids, library,
 * notifications) stay in its bottom bar or rail and are not published: its nav
 * is empty.
 */
import type { AppDeclaration, IAppSourceProvider } from '@dominevo/types'

export const VIEWER_APP_ID = 'viewer'

export function buildViewerApp(): AppDeclaration {
  return {
    id: VIEWER_APP_ID,
    label: { key: 'apps.viewer', fallback: 'Viewer' },
    icon: 'monitor',
    order: 10,
    entry: { kind: 'web', path: '/viewer/camstack/', auth: 'session-cookie' },
    reach: { kind: 'hub' },
    adminOnly: false,
    nav: [],
    takesSharedSearch: true,
    settings: { label: { key: 'apps.viewer.settings', fallback: 'Settings' }, path: '/settings' },
  }
}

export function createViewerAppSourceProvider(): IAppSourceProvider {
  return { listApps: async () => [buildViewerApp()] }
}
