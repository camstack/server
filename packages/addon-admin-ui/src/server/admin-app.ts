/**
 * The Admin app as the shell sees it (`app-source`, D1096). Its nav is
 * `buildAdminNavManifest()`, built from the table the sidebar is built from.
 */
import type { AppDeclaration } from '@camstack/types'
import { buildAdminNavManifest } from '../lib/nav-data'

export const ADMIN_APP_ID = 'admin'

export function buildAdminApp(): AppDeclaration {
  return {
    id: ADMIN_APP_ID,
    label: { key: 'apps.admin', fallback: 'Admin' },
    icon: 'settings',
    order: 20,
    // Served at the hub root; a browser handoff opens its session (D1094).
    entry: { kind: 'web', path: '/', auth: 'handoff' },
    reach: { kind: 'hub' },
    adminOnly: true,
    nav: buildAdminNavManifest(),
    takesSharedSearch: true,
    settings: null,
  }
}
