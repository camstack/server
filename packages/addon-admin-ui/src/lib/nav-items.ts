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
  Camera,
  Cpu,
  Database,
  Archive,
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
import {
  NAV_SECTION_SPECS,
  PAGE_REQUIRED_CAPABILITY,
  type NavItemSpec,
  type NavSectionKey,
} from './nav-data'

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

export type { NavSectionKey }

export interface NavSection {
  readonly key: NavSectionKey
  /** `null` for the top-of-sidebar entries, which render with no header. */
  readonly label: string | null
  readonly items: readonly NavItem[]
}

export { PAGE_REQUIRED_CAPABILITY }

/** Lucide name (the manifest's vocabulary, `nav-data.ts`) to the component. */
const NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  camera: Camera,
  plug: Plug,
  hammer: Hammer,
  'map-pin': MapPin,
  monitor: Monitor,
  library: Library,
  archive: Archive,
  network: Network,
  activity: Activity,
  'line-chart': LineChart,
  'git-branch': GitBranch,
  puzzle: Puzzle,
  sparkles: Sparkles,
  lock: Lock,
  globe: Globe,
  database: Database,
  bell: Bell,
  calendar: Calendar,
  settings: SettingsIcon,
  'scroll-text': ScrollText,
  terminal: Terminal,
}

/** The icon component of a manifest icon name; the sidebar shows a puzzle for an unknown one. */
export function navIconFor(name: string): LucideIcon {
  return NAV_ICONS[name] ?? Puzzle
}

export interface BuildNavSectionsParams {
  readonly t: NavTranslate
  readonly isAdmin: boolean
  /** Framed by the viewer app: its own Viewer entry would nest it in itself. */
  readonly embeddedByViewer?: boolean
}

function toNavItem(spec: NavItemSpec, t: NavTranslate): NavItem {
  const requiresCapability = PAGE_REQUIRED_CAPABILITY[spec.path]
  return {
    label: t(spec.labelKey, spec.fallback),
    icon: navIconFor(spec.icon),
    path: spec.path,
    ...(spec.adminOnly === true ? { adminOnly: true } : {}),
    ...(spec.keywords !== undefined ? { keywords: spec.keywords } : {}),
    ...(requiresCapability !== undefined ? { requiresCapability } : {}),
  }
}

/** Builds the 4 built-in sidebar sections from `NAV_SECTION_SPECS`, gated by `isAdmin`. Pure. */
export function buildNavSections({
  t,
  isAdmin,
  embeddedByViewer = false,
}: BuildNavSectionsParams): readonly NavSection[] {
  return NAV_SECTION_SPECS.map((section) => ({
    key: section.key,
    label: section.labelKey === null ? null : t(section.labelKey, section.fallback),
    items: section.items
      .filter(
        (item) =>
          (item.adminOnly !== true || isAdmin) &&
          !(embeddedByViewer && item.hiddenWhenEmbedded === true),
      )
      .map((item) => toNavItem(item, t)),
  }))
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
