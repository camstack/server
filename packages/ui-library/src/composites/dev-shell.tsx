import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react'
import type { ReactNode } from 'react'
import {
  createTRPCClient,
  createWSClient,
  wsLink,
  httpLink,
  splitLink,
  type TRPCClient,
} from '@trpc/client'
import type { AppRouter } from '@camstack/types'
import { createSystem, type System } from '@camstack/sdk'
import superjson from 'superjson'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '../theme/theme-provider'
import { useThemeMode } from '../theme/use-theme-mode'
import type { UseThemeModeReturn } from '../theme/types'
import { trpc as trpcReact } from '../trpc-react'
import { SystemProvider } from '../contexts/system-context'
import { useUiText } from '../contexts/ui-text'
import { applyFleetQueryDefaults } from '../lib/fleet-query-defaults'
import { LoginForm } from './login-form'

const STORAGE_KEY = 'camstack_dev_token'

export interface DevShellProps {
  children: (props: { trpc: TRPCClient<AppRouter>; theme: UseThemeModeReturn }) => ReactNode
  serverUrl?: string
  title?: string
}

interface DevShellContextValue {
  trpc: TRPCClient<AppRouter>
  token: string
  logout: () => void
}

const DevShellContext = createContext<DevShellContextValue | null>(null)

export function useDevShell(): DevShellContextValue {
  const ctx = useContext(DevShellContext)
  if (!ctx) {
    throw new Error('useDevShell must be used within a DevShell')
  }
  return ctx
}

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY)
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  )
}

function DevShellInner({
  children,
  serverUrl,
  title,
  token,
  onLogout,
}: {
  children: DevShellProps['children']
  serverUrl: string
  title?: string
  token: string
  onLogout: () => void
}) {
  const t = useUiText()
  const theme = useThemeMode()

  const links = useMemo(() => {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/trpc' // hub-path-ok: composed on the serverUrl prop
    const wsClient = createWSClient({
      url: wsUrl,
      connectionParams: () => ({ token }),
    })
    return [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient, transformer: superjson }),
        false: httpLink({
          url: `${serverUrl}/trpc`,
          transformer: superjson,
          headers: () => ({ authorization: `Bearer ${token}` }),
        }),
      }),
    ]
  }, [serverUrl, token])

  const trpc = useMemo(() => createTRPCClient<AppRouter>({ links }), [links])

  const trpcReactClient = useMemo(() => trpcReact.createClient({ links }), [links])

  // Build a `System` instance against the same backend so hooks that
  // read from `<SystemProvider>` (`useLiveEvent`, codegen'd
  // `use<Cap><Method>`, `useDevices`) work in the dev shell. The System
  // owns its own WebSocket distinct from the tRPC client above — both
  // hit `/trpc` on the same server, so the duplication is bounded to
  // dev mode and keeps the addon page identical to its production
  // mount inside the admin UI.
  const system: System = useMemo(
    () =>
      createSystem({
        serverUrl,
        token,
      }),
    [serverUrl, token],
  )
  useEffect(() => {
    void system.init().catch(() => undefined)
    return () => {
      system.close()
    }
  }, [system])

  const queryClient = useMemo(() => {
    const client = new QueryClient()
    applyFleetQueryDefaults(client)
    return client
  }, [])

  const themeLabel =
    theme.mode === 'dark'
      ? t('uiLibrary.devShell.themeDark', 'Dark')
      : theme.mode === 'light'
        ? t('uiLibrary.devShell.themeLight', 'Light')
        : t('uiLibrary.devShell.themeSystem', 'System')

  const contextValue = useMemo<DevShellContextValue>(
    () => ({ trpc, token, logout: onLogout }),
    [trpc, token, onLogout],
  )

  return (
    <SystemProvider system={system}>
      <trpcReact.Provider client={trpcReactClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <DevShellContext.Provider value={contextValue}>
            <div className="min-h-screen bg-background text-foreground">
              <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-warning/20 px-2 py-0.5 text-xs font-bold text-warning">
                    {t('uiLibrary.devShell.devMode', 'DEV MODE')}
                  </span>
                  {title && <span className="text-sm font-medium text-foreground">{title}</span>}
                  <span className="text-xs text-foreground-subtle">{serverUrl}</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={theme.toggleMode}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
                    title={t('uiLibrary.devShell.theme', 'Theme: {{mode}}', { mode: themeLabel })}
                  >
                    {theme.resolvedMode === 'dark' ? (
                      <SunIcon className="h-3.5 w-3.5" />
                    ) : (
                      <MoonIcon className="h-3.5 w-3.5" />
                    )}
                    {themeLabel}
                  </button>

                  <button
                    type="button"
                    onClick={onLogout}
                    className="rounded-md px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                  >
                    {t('uiLibrary.devShell.logout', 'Logout')}
                  </button>
                </div>
              </div>

              <div className="p-4">{children({ trpc, theme })}</div>
            </div>
          </DevShellContext.Provider>
        </QueryClientProvider>
      </trpcReact.Provider>
    </SystemProvider>
  )
}

export function DevShell({
  children,
  serverUrl = 'https://localhost:4443',
  title,
}: DevShellProps): JSX.Element | null {
  const [token, setToken] = useState<string | null>(getStoredToken)

  const handleLogin = useCallback(
    async (username: string, password: string) => {
      // Use tRPC client for auth (no token yet)
      const anonClient = createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url: `${serverUrl}/trpc`,
            transformer: superjson,
          }),
        ],
      })

      const res = await anonClient.auth.login.mutate({ username, password })
      const loginResult = res as { token?: string }
      if (!loginResult.token) throw new Error('No token returned')

      localStorage.setItem(STORAGE_KEY, loginResult.token)
      setToken(loginResult.token)
    },
    [serverUrl],
  )

  const handleLogout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setToken(null)
  }, [])

  if (!token) {
    return (
      <ThemeProvider>
        <LoginForm onLogin={handleLogin} serverUrl={serverUrl} />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <DevShellInner serverUrl={serverUrl} title={title} token={token} onLogout={handleLogout}>
        {children}
      </DevShellInner>
    </ThemeProvider>
  )
}
