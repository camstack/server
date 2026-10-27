import {
  MobileDrawer,
  useAddonPagesListPages,
  useAddonsListUpdates,
  useIsMidWidth,
  useIsMobile,
  useLiveEvent,
  useThemeMode,
} from '@camstack/ui-library'
import {
  DisplayPaletteGate,
  DisplayPaletteNotice,
} from '../components/pipeline/display-palette-gate'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  WifiOff,
} from 'lucide-react'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { GlobalSearch } from '../components/search/GlobalSearch'
import { PasskeyEnrollmentPrompt } from '../components/system/PasskeyEnrollmentPrompt'
import { ServerNamePrompt } from '../components/system/ServerNamePrompt'
import { AlertBell } from '../components/ui/AlertBell'
import { CriticalAlertsOnLoadPanel } from '../components/ui/CriticalAlertsOnLoadPanel'
import { useAuth } from '../contexts/auth-context'
import { useServerName } from '../hooks/use-server-name'
import { useConnectionHealth } from '../hooks/useConnectionHealth'
import { partitionAddonPages } from '../lib/addon-page-sections'
import { describeConnectionHealth } from '../lib/connection-health'
import { saveLastLocation } from '../lib/last-location'
import { ReleaseIdentityFooter } from '../components/release-identity-footer'
import { hubPath } from '../lib/mount'
import { buildNavSections, type NavItem, resolveAddonPageIcon } from '../lib/nav-items'
import type { AddonPageInfo } from './AddonPageLoader'
import { flattenPages } from './AddonPageLoader'
import { KeepAliveOutlet } from './KeepAliveOutlet'
import { ShellContentBoundary } from './AddonPageFrame'

const THEME_ICONS = { dark: Moon, light: Sun, system: Monitor } as const

/** Spinner for a page chunk still loading — sized to the CONTENT area, never
 *  the viewport, so the sidebar beside it stays exactly where it was. */
function PageContentFallback() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    </div>
  )
}

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const theme = useThemeMode()
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const isMidWidth = useIsMidWidth()
  // The hub's own name (D861) titles the tab and the sidebar. Until the hub has
  // answered there is no name, so the title stays what it was.
  const { info: serverName } = useServerName()
  useEffect(() => {
    document.title =
      serverName === null ? 'CamStack Admin' : `${serverName.name} \u00b7 CamStack Admin`
  }, [serverName])
  // Accurate connection model: the store behind this hook verifies hub
  // liveness with a hub-only probe (`GET /health`, no fan-out to agent
  // nodes) before classifying a WS drop, so a frozen/slow cluster node
  // renders a non-alarming "cluster degraded" banner instead of a
  // misleading "Server unreachable" (see lib/connection-health.ts).
  const connectionHealth = useConnectionHealth()
  const connectionBanner = describeConnectionHealth(connectionHealth)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Persist the current page so login / app-reopen can restore it
  // (last-location.ts filters out auth/utility paths).
  useEffect(() => {
    saveLastLocation(location.pathname + location.search)
  }, [location.pathname, location.search])
  // Sidebar fold state for mid-width viewports (md / 768–1023px). Persisted
  // across sessions via localStorage so the user's choice sticks.
  // Default: COLLAPSED on mid (recover canvas), OPEN on lg+ (full sidebar
  // is the desktop default).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem('camstack:sidebar-collapsed')
    return stored === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('camstack:sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // System nav group collapse state — keyed by group.key, persisted in
  // localStorage. Default: every group expanded (matches the prior flat
  // sidebar behaviour). Operators who want to fold sections away keep
  // their preference across reloads.
  const [collapsedGroups] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const stored = window.localStorage.getItem('camstack:sidebar-collapsed-groups')
      if (!stored) return new Set()
      const arr = JSON.parse(stored) as unknown
      return Array.isArray(arr)
        ? new Set(arr.filter((k): k is string => typeof k === 'string'))
        : new Set()
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      'camstack:sidebar-collapsed-groups',
      JSON.stringify([...collapsedGroups]),
    )
  }, [collapsedGroups])
  // Auto-collapse when entering mid breakpoint, auto-expand on lg+ (only
  // if the user hasn't explicitly toggled — we honour the manual choice
  // by storing it). Soft auto-collapse only kicks the FIRST time a user
  // hits mid width — after that their stored preference wins.
  useEffect(() => {
    if (isMidWidth) {
      // First-time visitors at mid width get collapsed by default.
      const stored = window.localStorage.getItem('camstack:sidebar-collapsed')
      if (stored === null) setSidebarCollapsed(true)
    }
  }, [isMidWidth])

  // Sidebar update badge — hub-scoped (the global count, not a
  // per-agent roster).
  const { data: updates = [] } = useAddonsListUpdates(
    { nodeId: 'hub' },
    { refetchInterval: 30_000 },
  )
  const updateCount = updates.length

  const queryClient = useQueryClient()

  // Boot timestamp — used to bound the empty-result defensive poll
  // (see `refetchInterval` below). useRef so we don't reset on rerender.
  const mountedAtRef = useRef<number>(Date.now())
  const ADDON_PAGES_BOOT_WINDOW_MS = 30_000
  const ADDON_PAGES_POLL_INTERVAL_MS = 2_000

  const { data: rawAddonPages } = useAddonPagesListPages(undefined, {
    // No long staleTime — we depend on `addon.page-ready` event-driven
    // invalidation. If we keep the cache stale-fresh for 60s, a boot-
    // time race where the FIRST query lands BEFORE benchmark registers
    // its source provider results in a cached empty array that never
    // refetches even after the event fires (because the page is
    // already past mount).
    staleTime: 0,
    refetchOnMount: 'always',
    // Defensive poll while the result is empty AND we're still inside
    // the boot window. The hub-side aggregator walks every
    // `addon-pages-source` provider; if a forked group-runner worker
    // has registered the cap but its Moleculer action hasn't fully
    // propagated yet ("Service '...listPages' is not found on
    // '<node>'"), the source is silently dropped from the response.
    // The aggregator now caches the last-good snapshot and re-emits
    // `AddonPageReady` when the source recovers, but on a hard reload
    // the cache is empty until the FIRST successful round-trip — so
    // we poll every 2s for up to 30s after mount to catch the
    // recovery without waiting for the event invalidation. After 30s
    // we stop polling: a genuinely-empty result (no addon contributing
    // pages) is a valid steady state and shouldn't burn requests.
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && data.length > 0) return false
      const elapsed = Date.now() - mountedAtRef.current
      if (elapsed >= ADDON_PAGES_BOOT_WINDOW_MS) return false
      return ADDON_PAGES_POLL_INTERVAL_MS
    },
  })
  // Dynamic addon pages are admin-only (the `/addon/:pagePath` route in
  // App.tsx is wrapped in `<ProtectedRoute requireAdmin>`), so hide the
  // whole section for non-admin operators rather than show entries that
  // would just route them to /access-denied on click.
  const addonPages: readonly AddonPageInfo[] = useMemo(
    () => (rawAddonPages && user?.isAdmin ? flattenPages(rawAddonPages) : []),
    [rawAddonPages, user?.isAdmin],
  )

  // Sidebar docking: split addon pages into built-in-section /
  // custom-section / legacy-group buckets (pure, memoised).
  const pageSections = useMemo(() => partitionAddonPages(addonPages), [addonPages])
  const detectionPages = pageSections.known.get('detection') ?? []
  const clusterPages = pageSections.known.get('cluster') ?? []
  const adminPages = pageSections.known.get('administration') ?? []

  // Auto-refresh addon pages when a new addon-pages-source provider
  // registers. tRPC keys queries as `[[<router>, <proc>], {input, type}]`
  // so we wrap once — passing a flat `['addonPages', 'listPages']` would
  // NEVER match the actual cache entry and the invalidation silently
  // no-ops (this is the bug that left the sidebar empty after boot
  // until manual reload).
  useLiveEvent('addon.page-ready', () => {
    queryClient.invalidateQueries({ queryKey: [['addonPages', 'listPages']] })
  })

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const isActive = (path: string) => {
    if (location.pathname === path || location.pathname.startsWith(path + '/')) return true
    return false
  }

  /**
   * Routes whose page component owns its own vertical scrolling
   * (master-detail layouts with sticky headers/tabs — e.g. Pipeline,
   * Timeline, Device Detail). For these, `<main>` must be
   * `overflow-hidden` so the outer scrollbar can't duplicate the inner
   * one. All other pages use natural flow and need `<main>` to scroll.
   */
  // /devices was on this list when DeviceList owned the entire viewport.
  // After the orphan-section split (Devices.tsx renders main list +
  // orphan list stacked) the page exceeds viewport on installs with
  // many devices and needs the outer <main> to scroll. /system/pipeline owns
  // scroll internally.
  // Managed-list section pages (`SectionedPage` + `DataTable fill`) own the
  // vertical scroll inside the table — `<main>` must not also scroll.
  const FULL_HEIGHT_ROUTES: readonly string[] = [
    '/system/pipeline',
    '/live',
    '/addon/osd-manager', // hub-path-ok: router pathname compare, not a URL
    '/build',
  ]
  const ownsScroll = FULL_HEIGHT_ROUTES.some(
    (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
  )

  // `adminOnly: true` ⇒ entry hidden from non-admin users. Keep the
  // route-level `<ProtectedRoute requireAdmin>` guard in App.tsx as the
  // authoritative check — this is UI-clutter cleanup, not a security
  // boundary. Source of truth = `user.isAdmin` from the auth context.
  const isAdmin = user?.isAdmin === true

  // Single registry drives BOTH the sidebar sections below and the global
  // search "page" domain (GlobalSearch reruns the same builder) — see
  // lib/nav-items.ts. A page added here shows up in the sidebar AND is
  // searchable; there is no separate hand-written list to fall out of sync.
  const navSections = useMemo(() => buildNavSections({ t, isAdmin }), [t, isAdmin])
  const TOP_ITEMS = navSections[0]?.items ?? []
  const DETECTION_ITEMS = navSections[1]?.items ?? []
  const CLUSTER_ITEMS = navSections[2]?.items ?? []
  const ADMIN_ITEMS = navSections[3]?.items ?? []

  const themeMode = theme?.mode ?? 'system'
  const THEME_LABELS: Record<string, string> = {
    dark: t('theme.dark'),
    light: t('theme.light'),
    system: t('theme.system'),
  }

  // `compact` collapses the sidebar to icons-only. Active in two cases:
  //   1. Desktop sidebar at mid+ width when the user has chosen to fold
  //   2. Never on mobile (the mobile drawer always shows full labels)
  const compact = sidebarCollapsed && !isMobile

  const navButtonCls = (active: boolean, size: 'lg' | 'md' = 'md'): string => {
    const padding = compact ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'
    const text = size === 'lg' ? 'text-[13px] font-medium' : 'text-[12px]'
    const activeCls = active
      ? size === 'lg'
        ? 'bg-primary/12 text-primary shadow-sm shadow-primary/5'
        : 'bg-primary/12 text-primary'
      : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
    // i18n-ignore: CSS class list
    return `flex w-full items-center gap-2.5 rounded-md ${padding} ${text} transition-all ${activeCls}`
  }

  /** Section label (full sidebar) / divider (compact). Hidden when the group is empty. */
  const renderSectionHeader = (itemCount: number, label: string) => {
    if (itemCount === 0) return null
    if (compact)
      return <div key={`sep-${label}`} className="pt-3 mb-1 mx-2 border-t border-border/60" />
    return (
      <div key={`hdr-${label}`} className="pt-4 pb-1.5 px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/60">
          {label}
        </span>
      </div>
    )
  }

  /** One addon-contributed page entry (docked into a section or the legacy group). */
  const renderAddonPage = (page: AddonPageInfo) => {
    const active = isActive(page.path)
    const Icon = resolveAddonPageIcon(page.icon)
    return (
      <button
        key={`${page.addonId}::${page.id}`}
        onClick={() => {
          navigate(page.path)
          setDrawerOpen(false)
        }}
        className={navButtonCls(active)}
        title={compact ? page.label : undefined}
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : ''}`} />
        {!compact && page.label}
      </button>
    )
  }

  /** One sidebar entry. The Addons entry carries the pending-updates badge. */
  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.path)
    const isAddons = item.path === '/system/addons'
    const testId = `nav-${item.path.replace(/^\//, '').replace(/\//g, '-')}`
    return (
      <button
        key={item.path}
        data-testid={testId}
        onClick={() => {
          navigate(item.path)
          setDrawerOpen(false)
        }}
        className={navButtonCls(active)}
        title={compact ? item.label : undefined}
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : ''}`} />
        {!compact && (
          <>
            <span className="flex-1 text-left">{item.label}</span>
            {isAddons && updateCount > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground leading-none">
                {updateCount}
              </span>
            )}
          </>
        )}
        {compact && isAddons && updateCount > 0 && (
          <span className="absolute mt-[-14px] ml-3 h-2 w-2 rounded-full bg-primary" />
        )}
      </button>
    )
  }

  const sidebarContent = (
    <>
      {/* App logo + collapse toggle. Right edge uses `pr-4` + `mr-2`
          on the button (~30px from chevron icon to the divider) so the
          fold control has unambiguous breathing room — earlier `pr-2`
          and `pr-3` still read as "flush against the border" at this
          sidebar width. Compact mode centres the chevron alone — no
          logo, no asymmetric padding. */}
      <div
        className={`flex h-14 items-center border-b border-border ${compact ? 'justify-center px-1' : 'pl-3 pr-4 gap-2'}`}
      >
        {!compact && (
          <img
            src={
              theme?.resolvedMode === 'light'
                ? hubPath('/brand/logo-horizontal-light.svg')
                : hubPath('/brand/logo-horizontal-dark.svg')
            }
            alt={t('layouts.appLayout.camstackAdmin', 'CamStack Admin')}
            className="h-9 flex-1 min-w-0"
          />
        )}
        {!isMobile && (
          <button
            onClick={() => setSidebarCollapsed((c) => !c)}
            className={`p-1.5 rounded-md hover:bg-surface-hover text-foreground-subtle transition-colors flex-shrink-0 ${compact ? '' : 'mr-2'}`}
            aria-label={
              sidebarCollapsed
                ? t('layouts.appLayout.expandSidebar', 'Expand sidebar')
                : t('layouts.appLayout.collapseSidebar', 'Collapse sidebar')
            }
            title={
              sidebarCollapsed
                ? t('layouts.appLayout.expandSidebar', 'Expand sidebar')
                : t('layouts.appLayout.collapseSidebar', 'Collapse sidebar')
            }
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        )}
      </div>

      {!compact && serverName !== null && (
        <div
          data-testid="sidebar-server-name"
          title={serverName.name}
          className="truncate border-b border-border px-3 py-1.5 text-xs font-medium text-foreground-muted"
        >
          {serverName.name}
        </div>
      )}

      {/* Global search — devices, pages (built-in + addon), integrations.
          Always visible at the top of the sidebar (icon-only trigger when
          folded); Ctrl/Cmd+K focuses it from anywhere in the app. */}
      <div className="border-b border-border pt-2">
        <GlobalSearch
          navSections={navSections}
          addonPages={addonPages}
          compact={compact}
          onNavigated={() => setDrawerOpen(false)}
        />
      </div>

      {/* Navigation */}
      <nav className={`flex-1 overflow-y-auto py-3 ${compact ? 'px-1.5' : 'px-2'} space-y-0.5`}>
        {/* Top entries — no section label for everyday entry points. */}
        {TOP_ITEMS.map((item) => renderNavItem(item))}

        {/* Detection — pipeline + intelligence + docked addon pages. */}
        {renderSectionHeader(
          DETECTION_ITEMS.length + detectionPages.length,
          t('nav.detectionSection', 'Detection'),
        )}
        {DETECTION_ITEMS.map((item) => renderNavItem(item))}
        {detectionPages.map((page) => renderAddonPage(page))}

        {/* Cluster — nodes, pipeline, addons, AI + docked addon pages. */}
        {renderSectionHeader(
          CLUSTER_ITEMS.length + clusterPages.length,
          t('nav.clusterSection', 'Cluster'),
        )}
        {CLUSTER_ITEMS.map((item) => renderNavItem(item))}
        {clusterPages.map((page) => renderAddonPage(page))}

        {/* Administration — identity, network, data + flat configuration. */}
        {renderSectionHeader(
          ADMIN_ITEMS.length + adminPages.length,
          t('system.title', 'Administration'),
        )}
        {ADMIN_ITEMS.map((item) => renderNavItem(item))}
        {adminPages.map((page) => renderAddonPage(page))}

        {/* Addon-created custom sections. */}
        {pageSections.custom.map((section) => (
          <div key={`custom-${section.id}`} className="contents">
            {renderSectionHeader(section.pages.length, section.label)}
            {section.pages.map((page) => renderAddonPage(page))}
          </div>
        ))}

        {/* Legacy "Addon Pages" group — pages that declare no section. */}
        {renderSectionHeader(pageSections.ungrouped.length, t('nav.addonPages', 'Addon Pages'))}
        {pageSections.ungrouped.map((page) => renderAddonPage(page))}
      </nav>

      {/* Bottom controls */}
      <div className={`border-t border-border ${compact ? 'p-1.5' : 'p-2'} space-y-0.5`}>
        <button
          onClick={() => theme?.toggleMode()}
          className={navButtonCls(false)}
          title={compact ? THEME_LABELS[themeMode] : undefined}
        >
          {(() => {
            const ThemeIcon = THEME_ICONS[themeMode]
            return <ThemeIcon className="h-3.5 w-3.5 shrink-0" />
          })()}
          {!compact && <span>{THEME_LABELS[themeMode]}</span>}
        </button>

        {/* Alerts */}
        <AlertBell variant="sidebar" compact={compact} />

        {/* My access — every user (admin or not) can view their own scope
            grants. Useful for non-admins to troubleshoot 403s without
            asking an admin. Sits right above logout so the profile-y
            section reads top-to-bottom: theme → alerts → my-access →
            sign out. */}
        <button
          type="button"
          onClick={() => navigate('/system/my-access')}
          className={navButtonCls(isActive('/system/my-access'))}
          title={compact ? t('system.myAccess', 'My access') : undefined}
        >
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          {!compact && <span className="truncate">{t('system.myAccess', 'My access')}</span>}
        </button>

        <button
          onClick={handleLogout}
          className={navButtonCls(false).replace('hover:text-foreground', 'hover:text-danger')}
          title={compact ? (user?.username ?? t('layouts.appLayout.logout', 'Logout')) : undefined}
        >
          <LogOut className="h-3.5 w-3.5 shrink-0" />
          {!compact && (
            <span className="truncate">
              {user?.username ?? t('layouts.appLayout.user', 'User')}
            </span>
          )}
        </button>

        <ReleaseIdentityFooter placement="sidebar" compact={compact} />
      </div>
    </>
  )

  return (
    // Safe-area insets: when installed as a PWA the OS draws its status
    // bar (iOS notch / Dynamic Island, Android system bar) and home
    // indicator on top of the viewport — `viewport-fit=cover` in
    // index.html opts us into the full screen but then the app paints
    // under those system surfaces and the header content gets clipped.
    // Padding the OUTERMOST background container by `env(safe-area-inset-*)`
    // pushes the inner flex column into the visible safe area while the
    // app's own background fills the status-bar gap, so the system bar
    // sits cleanly over our paint instead of over the controls.
    <div className="flex h-dvh overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Desktop sidebar — collapses to icons-only when `compact` */}
      {!isMobile && (
        <aside
          className={`flex flex-col border-r border-border bg-surface/80 backdrop-blur-sm shrink-0 transition-[width] duration-150 ease-out ${
            compact ? 'w-12' : 'w-48'
          }`}
        >
          {sidebarContent}
        </aside>
      )}

      {/* Mobile drawer */}
      {isMobile && (
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} width="w-64">
          {sidebarContent}
        </MobileDrawer>
      )}

      <div className="flex flex-1 flex-col min-w-0">
        {/* Connection status banner — severity mirrors the verified
            condition: danger (red) only when the hub itself failed the
            hub-only probe or the session expired; warning (amber) when
            the hub is alive but the live socket dropped (typically a
            degraded cluster node slowing the hub). */}
        {connectionBanner !== null && (
          <div
            className={`flex items-center justify-center gap-2 px-3 py-2 text-[12px] font-medium shrink-0 ${
              connectionBanner.severity === 'danger'
                ? 'bg-danger/90 text-white'
                : 'bg-warning/15 text-warning border-b border-warning/30'
            }`}
          >
            {connectionBanner.severity === 'danger' ? (
              <WifiOff className="h-3.5 w-3.5" />
            ) : (
              <Activity className="h-3.5 w-3.5" />
            )}
            <span>
              {t(connectionBanner.i18nKey, {
                defaultValue: connectionBanner.message,
                ...connectionBanner.i18nParams,
              })}
            </span>
            {connectionBanner.action === 'sign-in' && (
              <button
                onClick={() => logout()}
                className="ml-2 rounded border border-white/40 px-2 py-0.5 text-[11px] font-semibold hover:bg-white/10"
              >
                {t('connection.signIn', 'Sign in')}
              </button>
            )}
            {connectionBanner.showSpinner && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
        )}

        {/* Post-login passkey adoption nudge — renders only for users
            with ZERO enrolled passkeys (and an installed user-passkeys
            provider); dismissal persists ~30 days per user. */}
        <PasskeyEnrollmentPrompt />
        <ServerNamePrompt />
        <CriticalAlertsOnLoadPanel />

        {/* Mobile top bar */}
        {isMobile && (
          <header className="flex items-center h-12 border-b border-border px-3 shrink-0 bg-surface/80 backdrop-blur-sm">
            <button
              onClick={() => setDrawerOpen(true)}
              className="p-1.5 -ml-1.5 rounded-md hover:bg-surface-hover text-foreground-muted transition-colors"
              aria-label={t('layouts.appLayout.openMenu', 'Open menu')}
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex-1 flex justify-center">
              <img
                src={
                  theme?.resolvedMode === 'light'
                    ? hubPath('/brand/logo-horizontal-light.svg')
                    : hubPath('/brand/logo-horizontal-dark.svg')
                }
                alt={t('layouts.appLayout.camstack', 'CamStack')}
                className="h-7"
              />
            </div>
            <AlertBell />
          </header>
        )}

        <DisplayPaletteGate>
          <DisplayPaletteNotice />
          <main
            className={`relative flex-1 min-h-0 overscroll-contain bg-background ${
              ownsScroll ? 'overflow-hidden' : 'overflow-auto'
            }`}
          >
            {/* No dim/blur overlay while disconnected — the top banner
              already signals the state, and a blocking overlay would
              trap the operator on whatever page they were on. The hub
              reboots often in dev (tsx-watch); navigation must stay
              usable so cached pages can still be inspected. */}
            {/* The page chunk suspends HERE, inside the chrome.
              
              The app's only Suspense boundary used to sit above <Routes>, so a
              lazy page that had never been opened suspended the whole tree:
              the sidebar and the header vanished and the operator got a blank
              screen with a spinner in the middle of it. Navigation is the one
              thing that must survive a navigation — losing it mid-move leaves
              nowhere to go but the browser's back button.
              
              The outer boundary stays for the chrome-less routes (login,
              showroom, the embed player); this one owns everything that has a
              sidebar. */}
            <ShellContentBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageContentFallback />}>
                {/* Keep visited `/addon/*` mounted (hidden) so local draft state
                  survives tab switches; see KeepAliveOutlet. */}
                <KeepAliveOutlet />
              </Suspense>
            </ShellContentBoundary>
          </main>
        </DisplayPaletteGate>
      </div>
    </div>
  )
}
