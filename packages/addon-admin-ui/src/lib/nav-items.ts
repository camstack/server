/**
 * The admin-ui's built-in navigation registry — single source of truth for
 * the sidebar (`AppLayout.tsx`) AND the global search "page" domain
 * (`GlobalSearch.tsx`). Extracted from AppLayout so the two can never
 * diverge: a page added to the sidebar is automatically searchable, and a
 * label change updates both.
 *
 * Addon-contributed pages (Module Federation, see `AddonPageLoader.tsx`)
 * are NOT declared here — they arrive dynamically via
 * `useAddonPagesListPages()` and are docked into a section by
 * `partitionAddonPages()`. This module only covers the built-in routes.
 */
import {
  Activity,
  Bell,
  Bot,
  Box,
  Calendar,
  LayoutTemplate,
  Camera,
  Cpu,
  Database,
  Film,
  Gauge,
  GitBranch,
  Globe,
  GraduationCap,
  Hammer,
  Library,
  LineChart,
  Lock,
  type LucideIcon,
  MapPin,
  Monitor,
  Network,
  Plug,
  Puzzle,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react'
import { SYSTEM_PAGE_PATH } from './system-page-url'

/** The `t` call shapes `buildNavSections` uses. Production passes the hook's
 *  `t`, which satisfies this; tests can stub without i18next's TFunction brand. */
export type NavTranslate = {
  (key: string): string
  (key: string, defaultValue: string): string
}

export interface NavItem {
  readonly label: string
  readonly icon: LucideIcon
  readonly path: string
  /** Hidden from non-admin users. Route-level `<ProtectedRoute requireAdmin>`
   *  remains the authoritative check — this is UI-clutter cleanup only. */
  readonly adminOnly?: boolean
  /** Extra tokens for global search (old labels after a nav rename, aliases). */
  readonly keywords?: readonly string[]
  /** Capability the page needs a provider for (from `PAGE_REQUIRED_CAPABILITY`). */
  readonly requiresCapability?: string
}

export type NavSectionKey = 'top' | 'detection' | 'cluster' | 'administration'

export interface NavSection {
  readonly key: NavSectionKey
  /** `null` for the top-of-sidebar entries, which render with no header. */
  readonly label: string | null
  readonly items: readonly NavItem[]
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

function visibleTo(items: readonly NavItem[], isAdmin: boolean): readonly NavItem[] {
  return items
    .filter((item) => !item.adminOnly || isAdmin)
    .map((item) => {
      const requiresCapability = PAGE_REQUIRED_CAPABILITY[item.path]
      return requiresCapability === undefined ? item : { ...item, requiresCapability }
    })
}

export interface BuildNavSectionsParams {
  readonly t: NavTranslate
  readonly isAdmin: boolean
}

/** Builds the 4 built-in sidebar sections, gated by `isAdmin`. Pure — same
 *  inputs always produce the same sections, so it's safe to call from both
 *  the sidebar render and the search index build without a shared cache. */
export function buildNavSections({ t, isAdmin }: BuildNavSectionsParams): readonly NavSection[] {
  const top = visibleTo(
    [
      { label: t('nav.devices', 'Devices'), icon: Camera, path: '/devices' },
      { label: t('nav.integrations'), icon: Plug, path: '/integrations' },
      {
        label: t('nav.build', 'Build-your-self'),
        icon: Hammer,
        path: '/build',
        adminOnly: true,
      },
      {
        label: t('nav.locations', 'Locations'),
        icon: MapPin,
        path: '/locations',
        adminOnly: true,
      },
      { label: t('nav.viewer', 'Viewer'), icon: Monitor, path: '/live' },
    ],
    isAdmin,
  )

  const detection = visibleTo(
    [
      {
        label: t('nav.library', 'Library'),
        icon: Library,
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
        label: t('nav.recordings', 'Recordings'),
        icon: Film,
        path: '/recordings',
        adminOnly: true,
      },
    ],
    isAdmin,
  )

  const cluster = visibleTo(
    [
      {
        label: t('nav.nodes', 'Nodes'),
        icon: Network,
        path: '/system/nodes',
        adminOnly: true,
      },
      {
        // Device, node and storage series side by side (D899).
        label: t('nav.history', 'History'),
        icon: LineChart,
        path: '/system/history',
        adminOnly: true,
        keywords: ['charts', 'graphs', 'energy', 'temperature', 'metrics', 'trends'],
      },
      { label: t('nav.pipeline', 'Pipeline'), icon: GitBranch, path: '/system/pipeline' },
      { label: t('system.addons'), icon: Puzzle, path: '/system/addons', adminOnly: true },
      { label: t('system.ai', 'AI'), icon: Sparkles, path: '/system/ai', adminOnly: true },
    ],
    isAdmin,
  )

  const administration = visibleTo(
    [
      {
        label: t('system.identity', 'Identity & Access'),
        icon: Lock,
        path: '/system/identity',
        adminOnly: true,
      },
      {
        label: t('system.network', 'Network'),
        icon: Globe,
        path: '/system/network',
        adminOnly: true,
      },
      {
        label: t('system.integrations', 'Connectivity'),
        icon: Plug,
        path: '/system/integrations',
        adminOnly: true,
      },
      { label: t('system.data', 'Data'), icon: Database, path: '/system/data', adminOnly: true },
      {
        label: t('system.notifications', 'Notifications'),
        icon: Bell,
        path: '/system/notifications',
        adminOnly: true,
      },
      {
        label: t('system.calendars', 'Calendars'),
        icon: Calendar,
        path: '/system/calendars',
        adminOnly: true,
      },
      {
        label: t('system.templates', 'Templates'),
        icon: LayoutTemplate,
        path: '/system/templates',
        adminOnly: true,
      },
      {
        // System hosts Settings, Secrets and Capabilities as tabs
        // (`lib/system-page-url.ts`); they are not sidebar entries of their own.
        label: t('system.systemNav', 'System'),
        icon: SettingsIcon,
        path: SYSTEM_PAGE_PATH,
        adminOnly: true,
      },
      { label: t('system.logs', 'Logs'), icon: ScrollText, path: '/system/logs', adminOnly: true },
      {
        label: t('system.terminal', 'Terminal'),
        icon: Terminal,
        path: '/system/terminal',
        adminOnly: true,
      },
      // "My access" deliberately NOT listed here — it lives in the bottom
      // profile section of the sidebar (theme → alerts → my-access →
      // sign out), rendered directly by AppLayout rather than looped from
      // this registry, so it stays out of the "page" search domain too:
      // adding it here would recreate exactly the kind of hand-written,
      // sidebar-diverging entry this registry exists to prevent.
    ],
    isAdmin,
  )

  return [
    { key: 'top', label: null, items: top },
    { key: 'detection', label: t('nav.detectionSection', 'Detection'), items: detection },
    { key: 'cluster', label: t('nav.clusterSection', 'Cluster'), items: cluster },
    { key: 'administration', label: t('system.title', 'Administration'), items: administration },
  ]
}

/** Maps an addon page's `icon` string declaration to a Lucide component —
 *  shared by the sidebar (docked addon pages) and the search dropdown. */
const ADDON_PAGE_ICON_MAP: Record<string, LucideIcon> = {
  gauge: Gauge,
  puzzle: Puzzle,
  bot: Bot,
  cpu: Cpu,
  terminal: Terminal,
  box: Box,
  boxes: Box,
  monitor: Monitor,
  wrench: Wrench,
  activity: Activity,
  plug: Plug,
  'graduation-cap': GraduationCap,
}

export function resolveAddonPageIcon(icon: string): LucideIcon {
  return ADDON_PAGE_ICON_MAP[icon] ?? Puzzle
}

export interface NavChrome {
  readonly icon: LucideIcon
  readonly title: string
  readonly path: string
}

/** Page title + icon from the sidebar registry — never hand-duplicate in a shell. */
export function navChromeForPath(path: string, params: BuildNavSectionsParams): NavChrome | null {
  for (const section of buildNavSections(params)) {
    for (const item of section.items) {
      if (item.path === path) {
        return { icon: item.icon, title: item.label, path: item.path }
      }
    }
  }
  return null
}
