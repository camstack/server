/**
 * AppLayout inside the viewer shell (D1096): the admin's own sidebar and mobile
 * top bar are gone once the shell has said `hello`, and present until then.
 * Only the layout's collaborators that fetch or portal are stubbed; the layout,
 * the app-shell hook and the bridge rules are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AppLayout } from '../AppLayout'

const viewport = vi.hoisted(() => ({ mobile: false }))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useAddonPagesListPages: () => ({ data: [] }),
    useAddonsListUpdates: () => ({ data: [] }),
    useLiveEvent: () => undefined,
    useIsMobile: () => viewport.mobile,
    useIsMidWidth: () => false,
    useThemeMode: () => ({
      mode: 'dark',
      resolvedMode: 'dark',
      setMode: () => undefined,
      toggleMode: () => undefined,
    }),
  }
})
vi.mock('../../components/pipeline/display-palette-gate', () => ({
  DisplayPaletteGate: ({ children }: { children: ReactNode }) => <>{children}</>,
  DisplayPaletteNotice: () => null,
}))
vi.mock('../../components/search/GlobalSearch', () => ({
  GlobalSearch: ({
    floating,
    request,
  }: {
    floating?: boolean
    request?: { query: string } | null
  }) =>
    floating === true ? <div data-testid="floating-search">{request?.query ?? ''}</div> : null,
}))
vi.mock('../../components/system/PasskeyEnrollmentPrompt', () => ({
  PasskeyEnrollmentPrompt: () => null,
}))
vi.mock('../../components/system/ServerNamePrompt', () => ({ ServerNamePrompt: () => null }))
vi.mock('../../components/ui/AlertBell', () => ({ AlertBell: () => null }))
vi.mock('../../components/ui/CriticalAlertsOnLoadPanel', () => ({
  CriticalAlertsOnLoadPanel: () => null,
}))
vi.mock('../../components/release-identity-footer', () => ({ ReleaseIdentityFooter: () => null }))
vi.mock('../../components/PageRequiresCapability', () => ({
  NavItemCapabilityGate: ({ children }: { children: (absent: boolean) => ReactNode }) => (
    <>{children(false)}</>
  ),
}))
vi.mock('../../contexts/auth-context', () => ({
  useAuth: () => ({ user: { isAdmin: true, username: 'admin' }, logout: () => undefined }),
}))
vi.mock('../../hooks/use-server-name', () => ({ useServerName: () => ({ info: null }) }))
vi.mock('../../hooks/useConnectionHealth', () => ({ useConnectionHealth: () => null }))
vi.mock('../../lib/connection-health', () => ({ describeConnectionHealth: () => null }))
vi.mock('../AddonPageLoader', () => ({ flattenPages: () => [] }))
vi.mock('../AddonPageFrame', () => ({
  ShellContentBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../KeepAliveOutlet', () => ({ KeepAliveOutlet: () => null }))

const HELLO = { camstack: 'app-bridge', v: 1, type: 'hello' } as const
const originalParent = Object.getOwnPropertyDescriptor(window, 'parent')

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/devices']}>
        <AppLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function sayHello(shell: unknown, data: object = HELLO): void {
  const event = new MessageEvent('message', { data, origin: window.location.origin })
  Object.defineProperty(event, 'source', { value: shell })
  act(() => {
    window.dispatchEvent(event)
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true })
})

afterEach(() => {
  viewport.mobile = false
  if (originalParent !== undefined) Object.defineProperty(window, 'parent', originalParent)
})

describe('AppLayout chrome in the viewer shell', () => {
  it('desktop: the sidebar stays until hello, then goes', () => {
    const { container } = mount()
    expect(container.querySelector('aside')).not.toBeNull()
    sayHello(window.parent)
    expect(container.querySelector('aside')).toBeNull()
    expect(screen.queryByTestId('nav-devices')).toBeNull()
  })

  it('phone: the top bar and its menu stay until hello, then go', () => {
    viewport.mobile = true
    const { container } = mount()
    expect(container.querySelector('header[data-debug-header]')).not.toBeNull()
    sayHello(window.parent)
    expect(container.querySelector('header[data-debug-header]')).toBeNull()
  })

  it('a hello from another origin leaves the chrome', () => {
    const { container } = mount()
    const event = new MessageEvent('message', { data: HELLO, origin: 'https://other.example.com' })
    Object.defineProperty(event, 'source', { value: window.parent })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(container.querySelector('aside')).not.toBeNull()
  })

  it('chromeless: the shell search reaches the floating search box; standalone has none', () => {
    mount()
    expect(screen.queryByTestId('floating-search')).toBeNull()
    sayHello(window.parent)
    sayHello(window.parent, { ...HELLO, type: 'search', query: 'garage' })
    expect(screen.getByTestId('floating-search').textContent).toBe('garage')
  })
})
