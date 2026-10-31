import type { AddonPageDeclaration } from '@camstack/types'

/**
 * The CCU management page, surfaced through the `addon-pages-source` cap.
 * Mirrors the manifest `camstack.addons[].pages[]` entry — admin-ui's
 * `AddonPageLoader` loads `addon_provider_homematic_page/page` from
 * `/api/addon-pages/provider-homematic/remoteEntry.js`.
 */
export const HOMEMATIC_PAGES: readonly AddonPageDeclaration[] = [
  {
    id: 'homematic-ccu',
    label: 'Homematic CCU',
    icon: 'plug',
    path: '/addon/homematic-ccu',
    remoteName: 'addon_provider_homematic_page',
    bundle: 'remoteEntry.js',
    section: 'administration',
  },
]
