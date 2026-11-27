/**
 * The admin UI's built-in navigation as DATA — pure (no React, no icon
 * components), so the sidebar (`nav-items.ts`) and the `app-source` manifest the
 * addon publishes (`server/admin-app.ts`) are built from the very same table
 * and cannot drift (D1096). An icon is a lucide NAME here; `nav-items.ts` maps
 * it to the component.
 */
import type { AppNavSection } from '@camstack/types'
import { SYSTEM_PAGE_PATH } from './system-page-url'

export type NavSectionKey = 'top' | 'detection' | 'cluster' | 'administration'

export interface NavItemSpec {
  readonly labelKey: string
  /** English text, the fallback of the label in the manifest and in `t(key, fallback)`. */
  readonly fallback: string
  /** A lucide icon name (kebab-case). */
  readonly icon: string
  readonly path: string
  readonly adminOnly?: boolean
  readonly keywords?: readonly string[]
  /** Dropped when the admin UI is framed by the viewer (its own entry would nest it). */
  readonly hiddenWhenEmbedded?: boolean
}

export interface NavSectionSpec {
  readonly key: NavSectionKey
  readonly labelKey: string | null
  readonly fallback: string
  readonly items: readonly NavItemSpec[]
}

/**
 * The capability whose provider a built-in page needs, by path. The ONE place a
 * page declares what addon it depends on: the sidebar greys the entry and the
 * route shows a not-installed state from this, decided only on an answered
 * registry query. A page absent from the map has no addon dependency.
 */
export const PAGE_REQUIRED_CAPABILITY: Readonly<Record<string, string>> = {
  '/system/pipeline': 'pipeline-orchestrator',
  '/system/history': 'device-history',
  '/system/ai': 'llm',
}

export const NAV_SECTION_SPECS: readonly NavSectionSpec[] = [
  {
    key: 'top',
    labelKey: null,
    fallback: '',
    items: [
      {
        labelKey: 'nav.devices',
        fallback: 'Devices',
        icon: 'camera',
        path: '/devices',
      },
      {
        labelKey: 'nav.integrations',
        fallback: 'Integrations',
        icon: 'plug',
        path: '/integrations',
      },
      {
        labelKey: 'nav.build',
        fallback: 'Build-your-self',
        icon: 'hammer',
        path: '/build',
        adminOnly: true,
      },
      {
        labelKey: 'nav.locations',
        fallback: 'Locations',
        icon: 'map-pin',
        path: '/locations',
        adminOnly: true,
      },
      {
        labelKey: 'nav.viewer',
        fallback: 'Viewer',
        icon: 'monitor',
        path: '/live',
        hiddenWhenEmbedded: true,
      },
    ],
  },
  {
    key: 'detection',
    labelKey: 'nav.detectionSection',
    fallback: 'Detection',
    items: [
      {
        labelKey: 'nav.library',
        fallback: 'Library',
        icon: 'library',
        path: '/library',
        adminOnly: true,
        // Former Detection nav labels + common aliases so search still finds
        // the unified page after the hard cut to a single Library entry.
        keywords: [
          'People',
          'Vehicles',
          'Events',
          'Scenes',
          'plates',
          'faces',
          'detection-intelligence',
        ],
      },
      {
        labelKey: 'nav.archive',
        fallback: 'Archive',
        icon: 'archive',
        path: '/archive',
        adminOnly: true,
      },
    ],
  },
  {
    key: 'cluster',
    labelKey: 'nav.clusterSection',
    fallback: 'Cluster',
    items: [
      {
        labelKey: 'nav.nodes',
        fallback: 'Nodes',
        icon: 'network',
        path: '/system/nodes',
        adminOnly: true,
      },
      {
        // Device, node and storage series side by side (D899).
        labelKey: 'nav.history',
        fallback: 'History',
        icon: 'line-chart',
        path: '/system/history',
        adminOnly: true,
        keywords: ['charts', 'graphs', 'energy', 'temperature', 'metrics', 'trends'],
      },
      {
        labelKey: 'nav.pipeline',
        fallback: 'Pipeline',
        icon: 'git-branch',
        path: '/system/pipeline',
      },
      {
        labelKey: 'system.addons',
        fallback: 'Addons',
        icon: 'puzzle',
        path: '/system/addons',
        adminOnly: true,
      },
      {
        labelKey: 'system.ai',
        fallback: 'AI',
        icon: 'sparkles',
        path: '/system/ai',
        adminOnly: true,
      },
      {
        labelKey: 'nav.jobs',
        fallback: 'Jobs',
        icon: 'activity',
        path: '/system/jobs',
        adminOnly: true,
        keywords: ['activity', 'tasks', 'progress', 'adoption'],
      },
    ],
  },
  {
    key: 'administration',
    labelKey: 'system.title',
    fallback: 'Administration',
    items: [
      {
        labelKey: 'system.identity',
        fallback: 'Identity & Access',
        icon: 'lock',
        path: '/system/identity',
        adminOnly: true,
      },
      {
        labelKey: 'system.network',
        fallback: 'Network',
        icon: 'globe',
        path: '/system/network',
        adminOnly: true,
      },
      {
        labelKey: 'system.integrations',
        fallback: 'Connectivity',
        icon: 'plug',
        path: '/system/integrations',
        adminOnly: true,
      },
      {
        labelKey: 'system.data',
        fallback: 'Data',
        icon: 'database',
        path: '/system/data',
        adminOnly: true,
      },
      {
        labelKey: 'system.notifications',
        fallback: 'Notifications',
        icon: 'bell',
        path: '/system/notifications',
        adminOnly: true,
      },
      {
        labelKey: 'system.calendars',
        fallback: 'Calendars',
        icon: 'calendar',
        path: '/system/calendars',
        adminOnly: true,
      },
      {
        // System hosts Settings, Secrets and Capabilities as tabs
        // (`lib/system-page-url.ts`); they are not sidebar entries of their own.
        labelKey: 'system.systemNav',
        fallback: 'System',
        icon: 'settings',
        path: SYSTEM_PAGE_PATH,
        adminOnly: true,
      },
      {
        labelKey: 'system.logs',
        fallback: 'Logs',
        icon: 'scroll-text',
        path: '/system/logs',
        adminOnly: true,
      },
      {
        labelKey: 'system.terminal',
        fallback: 'Terminal',
        icon: 'terminal',
        path: '/system/terminal',
        adminOnly: true,
      },
      // "My access" deliberately NOT listed here — it lives in the bottom
      // profile section of the sidebar (theme → alerts → my-access →
      // sign out), rendered directly by AppLayout rather than looped from
      // this table, so it stays out of the "page" search domain too.
    ],
  },
]

/**
 * The manifest the admin UI publishes through `app-source`: every item
 * (the role filter is the aggregator's), the Viewer entry left out because the
 * shell frames Admin and lists the Viewer as an app of its own.
 */
export function buildAdminNavManifest(): AppNavSection[] {
  return NAV_SECTION_SPECS.map((section) => ({
    id: section.key,
    label: section.labelKey === null ? null : { key: section.labelKey, fallback: section.fallback },
    items: section.items
      .filter((item) => item.hiddenWhenEmbedded !== true)
      .map((item) => {
        const requiresCapability = PAGE_REQUIRED_CAPABILITY[item.path]
        return {
          id: item.path,
          label: { key: item.labelKey, fallback: item.fallback },
          icon: item.icon,
          path: item.path,
          ...(item.adminOnly === true ? { adminOnly: true } : {}),
          ...(item.keywords !== undefined ? { keywords: [...item.keywords] } : {}),
          ...(requiresCapability !== undefined ? { requiresCapability } : {}),
        }
      }),
  }))
}
