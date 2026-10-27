import {
  applyFleetQueryDefaults,
  ConfirmDialogProvider,
  type CustomFieldRendererMap,
  type CustomFieldRendererProps,
  CustomFieldRenderersProvider,
  DeviceFleetFromServer,
  RoleDisplayDefaultsFromServer,
  SystemProvider,
  ThemeProvider,
  WidgetRegistryProvider,
} from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { DeviceQuickDetailHost } from './components/device/DeviceQuickDetail'
import { ModelSelector } from './components/form-builder/ModelSelector'
import { RedirectKeepingQuery } from './components/RedirectKeepingQuery'
import { KeychainRevealHost } from './components/system/KeychainRevealHost'
import { ReconnectOverlay } from './components/system/ReconnectOverlay'
import { SystemTabRedirect } from './components/system/SystemTabRedirect'
import { ToastContainer } from './components/ui/ToastContainer'
import { AddonIconsProvider } from './contexts/addon-icons-context'
import { AuthProvider, useAuth } from './contexts/auth-context'
import { AdminUiTextProvider } from './i18n/AdminUiTextProvider'
import { useBootGate } from './hooks/useBootGate'
import { useSocketWatchdog } from './hooks/useSocketWatchdog'
import { AddonPageLoader } from './layouts/AddonPageLoader'
import { PageRequiresCapability } from './components/PageRequiresCapability'
import { AppLayout } from './layouts/AppLayout'
import { ProtectedRoute } from './layouts/ProtectedRoute'
import { onSessionRotated, reconnectWithFreshSession, recoverSession } from './lib/admin-session'
import { getSystem, resetSystem } from './lib/backend'
import { COMPOSITION_EDITOR_ROUTE, NEW_COMPOSITION_PATH } from './lib/customization-routes'
import { integrationHubHref } from './lib/integration-hub-url'
import { readLastLocation } from './lib/last-location'
import { stripLegacyAdminPrefix } from './lib/legacy-admin-path'
import { routerBasename } from './lib/mount'
import { SYSTEM_LEGACY_ROUTES, SYSTEM_PAGE_PATH } from './lib/system-page-url'
import { AccessDeniedPage } from './pages/AccessDenied'
import { ChangePasswordPage } from './pages/ChangePassword'
// Critical first-paint pages — kept eager so they render without a Suspense flash
import { LoginPage } from './pages/Login'
import { trpc } from './trpc'
import type { ConfigModelSelectorField } from './types/config-ui'
import { useTranslation } from 'react-i18next'

/** `/admin/<route>` (old SSO returns, mailed links) → `<route>`, query and fragment kept. */
function LegacyAdminRedirect() {
  const { pathname, search, hash } = useLocation()
  return <Navigate to={`${stripLegacyAdminPrefix(pathname)}${search}${hash}`} replace />
}

/**
 * Index-route element: reopen the app on the last page the operator
 * visited (persisted by AppLayout) instead of always the devices page.
 */
function RestoreLastLocation() {
  return <Navigate to={readLastLocation() ?? '/devices'} replace />
}

// Route-level pages — code-split so they are only loaded when visited
const DevicesPage = lazy(() => import('./pages/Devices').then((m) => ({ default: m.DevicesPage })))
const IntegrationsPage = lazy(() =>
  import('./pages/Integrations').then((m) => ({ default: m.IntegrationsPage })),
)
const IntegrationDetailPage = lazy(() =>
  import('./pages/IntegrationDetail').then((m) => ({
    default: m.IntegrationDetailPage,
  })),
)
const PipelinePage = lazy(() =>
  import('./pages/Pipeline').then((m) => ({ default: m.PipelinePage })),
)
const DeviceDetailPage = lazy(() =>
  import('./pages/DeviceDetail').then((m) => ({ default: m.DeviceDetailPage })),
)
const ShowroomPage = lazy(() =>
  import('./pages/Showroom').then((m) => ({ default: m.ShowroomPage })),
)
const EmbedPlayerPage = lazy(() =>
  import('./pages/EmbedPlayerPage').then((m) => ({
    default: m.EmbedPlayerPage,
  })),
)
const LibraryPage = lazy(() => import('./pages/Library').then((m) => ({ default: m.LibraryPage })))
const RecordingsPage = lazy(() =>
  import('./pages/Recordings').then((m) => ({ default: m.RecordingsPage })),
)
const ViewerPage = lazy(() => import('./pages/Viewer').then((m) => ({ default: m.ViewerPage })))
// Build-your-self: automations + scripts (core blocks) + composed devices. A
// ROOT page, not a /system one: this is what the operator authors, not how the
// installation is configured.
const BuildPage = lazy(() => import('./pages/Build').then((m) => ({ default: m.BuildPage })))
const CompositionEditorPage = lazy(() =>
  import('./pages/CompositionEditorPage').then((m) => ({
    default: m.CompositionEditorPage,
  })),
)
const LocationsPage = lazy(() =>
  import('./pages/Locations').then((m) => ({ default: m.LocationsPage })),
)
// System pages
const AddonsPage = lazy(() =>
  import('./pages/system/Addons').then((m) => ({ default: m.AddonsPage })),
)
const AiProfilesPage = lazy(() =>
  import('./pages/system/AiProfiles').then((m) => ({
    default: m.AiProfilesPage,
  })),
)
const MyAccessPage = lazy(() =>
  import('./pages/system/MyAccess').then((m) => ({ default: m.MyAccessPage })),
)
const LogsPage = lazy(() => import('./pages/system/Logs').then((m) => ({ default: m.LogsPage })))
const IdentityPage = lazy(() =>
  import('./pages/system/Identity').then((m) => ({ default: m.IdentityPage })),
)
const NetworkPage = lazy(() =>
  import('./pages/system/Network').then((m) => ({ default: m.NetworkPage })),
)
const SystemIntegrationsPage = lazy(() =>
  import('./pages/system/Integrations').then((m) => ({
    default: m.IntegrationsPage,
  })),
)
const DataPage = lazy(() => import('./pages/system/Data').then((m) => ({ default: m.DataPage })))
// System: Settings, Secrets and Capabilities as `?tab=` tabs; Terminal stays standalone.
const SystemPage = lazy(() =>
  import('./pages/system/System').then((m) => ({ default: m.SystemPage })),
)
const ClusterPage = lazy(() =>
  import('./pages/system/Cluster').then((m) => ({ default: m.ClusterPage })),
)
const TerminalPage = lazy(() =>
  import('./pages/system/Terminal').then((m) => ({ default: m.TerminalPage })),
)
const NotificationsPage = lazy(() =>
  import('./pages/system/Notifications').then((m) => ({
    default: m.NotificationsPage,
  })),
)
const HistoryPage = lazy(() =>
  import('./pages/system/History').then((m) => ({
    default: m.HistoryPage,
  })),
)
const CalendarsPage = lazy(() =>
  import('./pages/system/Calendars').then((m) => ({
    default: m.CalendarsPage,
  })),
)

// gcTime: 0 — drop cached query data immediately when the last observer
// unmounts (i.e. when navigating away from a page). This prevents stale
// data from a previous page being shown on the next visit.
// staleTime: 0 — always consider data stale so every mount triggers a
// fresh fetch. Together with gcTime: 0 the cache acts as an in-flight
// dedup layer only; once all observers are gone the data is gone too.
// Neither setting affects refetchInterval polling while a page is mounted.
// Visited `/addon/*` pages stay mounted via KeepAliveOutlet, so their
// observers (and local useState drafts) survive navigation without raising
// these defaults globally.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 0,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})
// …except the fleet list, which every surface reads and which those two
// defaults would make N observers refetch N times at boot. The window has one
// owner — see `applyFleetQueryDefaults` (D274).
applyFleetQueryDefaults(queryClient)

// Model-selector adapter — admin-ui's ModelSelector talks to the model
// catalog cap (download status, registry, …); ui-library doesn't have
// that dependency.
function ModelSelectorAdapter({ field, value, onChange, disabled }: CustomFieldRendererProps) {
  return (
    <ModelSelector
      field={field as ConfigModelSelectorField}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

// Custom field renderers — addon contributions to the settings schema
// can declare field types not natively rendered by ui-library
// (`model-selector` → catalog-aware model browser). The form dispatcher in ui-library's
// `config-form-field` looks up the type here on the `default:` branch.
const CUSTOM_FIELD_RENDERERS: CustomFieldRendererMap = {
  'model-selector': ModelSelectorAdapter,
}

interface AppShellProps {
  children: ReactNode
}

// Read auth so we can recreate the unified `System` instance when the
// user identity changes. The System owns a WebSocket whose handshake
// captures the auth token at connect time — login/logout must
// therefore force a fresh System so the new connectionParams() runs
// with the latest token.
//
// `useSocketWatchdog` adds a second recreate trigger: browser-platform
// signals (tab resume after long background, network online event,
// BFCache restore) that suggest the WS may be stale. Both the trpc
// react-query proxy and the System mirror get a fresh handshake.
//
// The same `system.trpcClient` reference seeds the `<trpc.Provider>`
// below — single client, single WebSocket, every consumer (React
// Query hooks, vanilla `useDeviceProxy(client.trpc, …)` calls) talks
// to the same socket.
function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  // `tick` refreshes `<trpc.Provider client={system.trpcClient}>` after
  // auth-user change (new System via `resetSystem`) OR after a watchdog
  // reconnect (`System.reconnect()` on the SAME instance — no remount of
  // the tree, so open modals keep their local state).
  const [tick, setTick] = useState(0)
  const lastUserId = useRef<string | null>(user?.username ?? null)
  useEffect(() => {
    const currentId = user?.username ?? null
    if (currentId !== lastUserId.current) {
      lastUserId.current = currentId
      resetSystem()
      setTick((n) => n + 1)
    }
  }, [user])

  const system = useMemo(() => getSystem(), [tick])

  // Boot gate: children mount once the TRANSPORT PROBE has agreed on an
  // identity — `useBootGate` owns the rule and the reasoning, including why
  // the device-mirror warm-boot (three whole-fleet round-trips) is started
  // here but never awaited.

  const rebuildSocket = useCallback((): void => {
    // Re-handshake the WS on the live System. Do NOT `resetSystem()` —
    // that builds a new instance, re-arms `useBootGate` (bootReady→false
    // → BootSplash), and unmounts every open dialog the operator still
    // had on screen after a ≥30s background tab.
    getSystem().reconnect()
    setTick((n) => n + 1)
    // Force every React Query consumer to refetch through the freshly
    // handshaken WS. Without this, queries keep showing pre-suspend
    // data until their `staleTime` expires or an event-bus
    // invalidation eventually fires — a multi-minute background
    // suspension would leave the dashboard reading stale snapshots
    // long after reconnect completes.
    void queryClient.invalidateQueries()
  }, [])
  // After a background stretch the access token may have expired while the
  // keeper's timer was frozen: refresh FIRST, or the handshake is anonymous.
  const reconnectAll = useCallback(
    (): Promise<void> => reconnectWithFreshSession(rebuildSocket),
    [rebuildSocket],
  )
  useSocketWatchdog(reconnectAll)
  // A rotated token reaches `setToken` only; the socket authenticated once, at
  // its handshake, so re-handshake it when it still carries the old token.
  useEffect(
    () =>
      onSessionRotated(() => {
        if (getSystem().isSocketTokenStale()) rebuildSocket()
      }),
    [rebuildSocket],
  )
  const recover = useCallback(async (): Promise<boolean> => {
    const alive = await recoverSession()
    if (alive) rebuildSocket()
    return alive
  }, [rebuildSocket])

  const { bootReady, bootError } = useBootGate(system, user ?? null, logout, recover)

  return (
    <AdminUiTextProvider>
      <SystemProvider system={system}>
        <trpc.Provider client={system.trpcClient} queryClient={queryClient}>
          <WidgetRegistryProvider>
            {/* Every device row below resolves its icon through the operator's
              per-ROLE defaults ("Set as default for all X sensors"). ONE read
              at the top, published by context, so a row in any list — the
              devices table, a detail page's children, a room card — draws the
              same glyph without a query of its own. */}
            <RoleDisplayDefaultsFromServer>
              {/* One slim fleet for every device name. A row reads its parent
                  from this cache; it does not call getDevice. */}
              <DeviceFleetFromServer>{bootReady ? children : <BootSplash />}</DeviceFleetFromServer>
            </RoleDisplayDefaultsFromServer>
            {bootReady && <ReconnectOverlay />}
            {bootError !== null && bootReady && (
              // Safe-area offsets: this banner is `fixed` (viewport-relative)
              // and mounted outside AppLayout, so it inherits none of the
              // shell's inset padding. They collapse to `1rem` when 0.
              <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-[calc(env(safe-area-inset-right)+1rem)] z-50 max-w-sm rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning shadow-lg">
                {t('app.bootProbeFailed', 'Boot probe failed:')} {bootError}. Retrying in
                background.
              </div>
            )}
          </WidgetRegistryProvider>
        </trpc.Provider>
      </SystemProvider>
    </AdminUiTextProvider>
  )
}

/** Splash shown while the transport probe (`auth.me`) resolves. */
function BootSplash() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex items-center gap-3 text-sm text-foreground-subtle">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        {t('app.connecting', 'Connecting…')}
      </div>
    </div>
  )
}

/** Fallback shown by the Suspense boundary while a lazy page chunk is loading. */
function PageSuspenseFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider defaultMode="dark">
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppShell>
            <ConfirmDialogProvider>
              <KeychainRevealHost>
                <CustomFieldRenderersProvider renderers={CUSTOM_FIELD_RENDERERS}>
                  <BrowserRouter basename={routerBasename()}>
                    {/* Inside BrowserRouter so the modal's <Link> has a
                      basename (mounting the host in AppShell crashed
                      with "basename is null"). Every DeviceItem below
                      draws the glyph from this context. */}
                    <DeviceQuickDetailHost>
                      <Suspense fallback={<PageSuspenseFallback />}>
                        <Routes>
                          <Route path="/login" element={<LoginPage />} />
                          <Route path="/admin/*" element={<LegacyAdminRedirect />} />
                          <Route path="/admin" element={<LegacyAdminRedirect />} />
                          <Route
                            path="/change-password"
                            element={
                              <ProtectedRoute>
                                <ChangePasswordPage />
                              </ProtectedRoute>
                            }
                          />
                          <Route path="/showroom" element={<ShowroomPage />} />
                          {/* Login-bypassing, chrome-less live player for the native
                        iOS WKWebView. Auth comes from a JWT injected into
                        window.__CAMSTACK_EMBED__ before load — NO auth gate,
                        so it must stay OUTSIDE ProtectedRoute/AppLayout. */}
                          <Route path="/embed/player" element={<EmbedPlayerPage />} />
                          <Route
                            element={
                              <ProtectedRoute>
                                <AddonIconsProvider>
                                  <AppLayout />
                                </AddonIconsProvider>
                              </ProtectedRoute>
                            }
                          >
                            <Route index element={<RestoreLastLocation />} />
                            {/* Mounted inside AppLayout so the sidebar stays
                          visible — operators landing here from a denied
                          deep-link can still reach pages they DO have
                          access to without a fresh login. */}
                            <Route path="/access-denied" element={<AccessDeniedPage />} />
                            <Route path="/dashboard" element={<Navigate to="/devices" replace />} />
                            <Route path="/devices" element={<DevicesPage />} />
                            {/* /cameras was the legacy entry — keep a redirect so
                          bookmarks + linked references resolve. */}
                            <Route path="/cameras" element={<Navigate to="/devices" replace />} />
                            <Route path="/integrations" element={<IntegrationsPage />} />
                            <Route
                              path="/integrations/:integrationId"
                              element={<IntegrationDetailPage />}
                            />
                            <Route
                              path="/system/pipeline"
                              element={
                                <PageRequiresCapability path="/system/pipeline">
                                  <PipelinePage />
                                </PageRequiresCapability>
                              }
                            />
                            {/* Pre-`/system` bookmarks and mistyped paths. */}
                            <Route
                              path="/pipeline"
                              element={<Navigate to="/system/pipeline" replace />}
                            />
                            {/* The hub-served viewer, framed same-origin. `/live`, not
                          `/viewer`: that path is the hub's own redirect into the
                          viewer app and is excluded from the SPA fallback. */}
                            <Route path="/live" element={<ViewerPage />} />
                            <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
                            <Route
                              path="/system/logs"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <LogsPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/addons"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <AddonsPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/ai"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <AiProfilesPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/settings"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <SystemPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/nodes"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <ClusterPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/notifications"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <NotificationsPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/history"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <HistoryPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/calendars"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <CalendarsPage />
                                </ProtectedRoute>
                              }
                            />
                            {/* Combined pages */}
                            <Route
                              path="/system/identity"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <IdentityPage />
                                </ProtectedRoute>
                              }
                            />
                            {/* "My access" — every authenticated user can see their own
                          scope grants (no admin gate). Useful for non-admin users to
                          troubleshoot 403s and verify what an admin granted them. */}
                            <Route path="/system/my-access" element={<MyAccessPage />} />
                            <Route
                              path="/system/network"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <NetworkPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/integrations"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <SystemIntegrationsPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/system/data"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <DataPage />
                                </ProtectedRoute>
                              }
                            />

                            {/* Former standalone System pages → their tab of System. */}
                            <Route
                              path="/system"
                              element={<Navigate to={SYSTEM_PAGE_PATH} replace />}
                            />
                            <Route
                              path="/system/terminal"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <TerminalPage />
                                </ProtectedRoute>
                              }
                            />
                            {SYSTEM_LEGACY_ROUTES.map((r) => (
                              <Route
                                key={r.path}
                                path={r.path}
                                element={<SystemTabRedirect tab={r.tab} />}
                              />
                            ))}
                            {/* Legacy single-cap routes — redirect to combined page with the
                          matching tab pre-selected. Operators with bookmarks land on the
                          right tab. */}
                            <Route
                              path="/system/users"
                              element={<Navigate to="/system/identity?tab=users" replace />}
                            />
                            <Route
                              path="/system/api-keys"
                              element={<Navigate to="/system/identity?tab=api-keys" replace />}
                            />
                            <Route
                              path="/system/authentication"
                              element={
                                <Navigate to={integrationHubHref('authentication')} replace />
                              }
                            />
                            <Route
                              path="/system/linked-sessions"
                              element={
                                <Navigate to="/system/identity?tab=linked-sessions" replace />
                              }
                            />
                            <Route
                              path="/system/remote-access"
                              element={<Navigate to={integrationHubHref('remoteAccess')} replace />}
                            />
                            <Route
                              path="/system/turn"
                              element={<Navigate to={integrationHubHref('turn')} replace />}
                            />
                            <Route
                              path="/system/storage"
                              element={<Navigate to="/system/data?tab=storage" replace />}
                            />
                            <Route
                              path="/system/backup"
                              element={<Navigate to="/system/data?tab=backup" replace />}
                            />
                            <Route
                              path="/library"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <LibraryPage />
                                </ProtectedRoute>
                              }
                            />
                            {/* Legacy standalone Retrain route → Training addon page */}
                            <Route
                              path="/retrain"
                              element={<Navigate to="/addon/training" replace />} // hub-path-ok: react-router redirect, not a URL
                            />
                            <Route
                              path="/recordings"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <RecordingsPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/build"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <BuildPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path={NEW_COMPOSITION_PATH}
                              element={
                                <ProtectedRoute requireAdmin>
                                  <CompositionEditorPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path={COMPOSITION_EDITOR_ROUTE}
                              element={
                                <ProtectedRoute requireAdmin>
                                  <CompositionEditorPage />
                                </ProtectedRoute>
                              }
                            />
                            <Route
                              path="/locations"
                              element={
                                <ProtectedRoute requireAdmin>
                                  <LocationsPage />
                                </ProtectedRoute>
                              }
                            />
                            {/* `/automation` became Build-your-self at `/build`. The
                          tab ids did NOT change, so the query string is carried
                          across rather than dropped. */}
                            <Route
                              path="/automation"
                              element={<RedirectKeepingQuery to="/build" />}
                            />
                            <Route
                              path="/addon/:pagePath" // hub-path-ok: router pattern, not a URL
                              element={
                                <ProtectedRoute requireAdmin>
                                  <AddonPageLoader />
                                </ProtectedRoute>
                              }
                            />
                            {/* Unknown in-app paths → Devices (not a blank "no routes" screen). */}
                            <Route path="*" element={<Navigate to="/devices" replace />} />
                          </Route>
                        </Routes>
                      </Suspense>
                    </DeviceQuickDetailHost>
                  </BrowserRouter>
                  <ToastContainer />
                </CustomFieldRenderersProvider>
              </KeychainRevealHost>
            </ConfirmDialogProvider>
          </AppShell>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
