// @vitest-environment jsdom
/**
 * The quick-detail modal's Detail tab is the viewer's device detail: the hero
 * card (which carries consumables and the History button) in the bare frame,
 * with no legacy fallback and no separate History tab. Leaving for the full
 * detail page asks before dropping unsaved edits.
 */
import { ConfirmDialogProvider, useDeviceQuickDetailOpen } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

interface HeroMockProps {
  readonly onNavigate?: (path: string) => void
  readonly onDrawn?: (drawn: boolean) => void
}

const hero = vi.hoisted(() => ({
  props: null as (HeroMockProps & Record<string, unknown>) | null,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerGetDevice: () => ({
      data: { id: 7, name: 'Driveway', location: 'Hall' },
    }),
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetTags: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetRole: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetDisplay: () => ({ mutateAsync: vi.fn() }),
    useSystem: () => ({ trpcClient: {} }),
  }
})

vi.mock('../overview-adapters/DeviceInfoAdapter', async () => {
  const { useQuickDetailSave } = await import('../quick-detail-save')
  return {
    DeviceInfoAdapter: () => {
      const api = useQuickDetailSave()
      return (
        <button type="button" onClick={() => api?.setIdentityName('Renamed')}>
          edit-name
        </button>
      )
    },
  }
})

vi.mock('../hero/DeviceHeroCard', () => ({
  DeviceHeroCard: (props: HeroMockProps & Record<string, unknown>) => {
    hero.props = props
    return (
      <div data-testid="hero-card">
        <button type="button" onClick={() => props.onNavigate?.('/devices/9')}>
          hero-open-other
        </button>
        <button type="button" onClick={() => props.onDrawn?.(false)}>
          hero-settled-empty
        </button>
      </div>
    )
  },
}))
vi.mock('../tabs/DeviceAggregateSection', () => ({
  DeviceAggregateSection: () => <div>export</div>,
}))

import { DeviceQuickDetailHost } from '../DeviceQuickDetail'

function Open(): ReactNode {
  const open = useDeviceQuickDetailOpen()
  return (
    <button type="button" onClick={() => open?.(7)}>
      open-quick
    </button>
  )
}

function LocationProbe(): ReactNode {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}</div>
}

function renderModal(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/devices']}>
          <LocationProbe />
          <DeviceQuickDetailHost>
            <Open />
          </DeviceQuickDetailHost>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

function openModal(): void {
  fireEvent.click(screen.getByRole('button', { name: 'open-quick' }))
}

describe('DeviceQuickDetail modal', () => {
  it('shows the viewer detail on Detail: the model card alone, in the bare frame, no History tab', () => {
    renderModal()
    openModal()
    expect(screen.getByTestId('hero-card')).toBeTruthy()
    expect(hero.props).toMatchObject({ deviceId: 7, legacyFallback: false })
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Detail', 'Device info', 'Export']),
    )
  })

  it('opens the device page immediately when nothing is dirty', () => {
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'Open device page' }))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    expect(screen.getByTestId('loc').textContent).toBe('/devices/7')
    expect(screen.queryByRole('heading', { name: 'Driveway' })).toBeNull()
  })

  it('opens on the device detail tab', () => {
    renderModal()
    openModal()
    expect(screen.getByTestId('hero-card')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Open device page' })).toHaveLength(1)
  })

  it('asks before leaving unsaved edits, and stays when the operator cancels', async () => {
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'edit-name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open device page' }))
    const title = await screen.findByText('Discard unsaved changes?')
    const dialog = title.closest('dialog')
    expect(dialog).toBeTruthy()
    if (dialog === null) return
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('loc').textContent).toBe('/devices')
    expect(screen.getByRole('heading', { name: 'Driveway' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open device page' }))
    const again = await screen.findByText('Discard unsaved changes?')
    const confirmDialog = again.closest('dialog')
    if (confirmDialog === null) throw new Error('confirm dialog missing')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/devices/7')
    })
    expect(screen.queryByRole('heading', { name: 'Driveway' })).toBeNull()
  })

  it('confirms a hero navigation over unsaved edits, and navigates nowhere on cancel', async () => {
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'edit-name' }))
    fireEvent.click(screen.getByRole('button', { name: 'hero-open-other' }))
    const title = await screen.findByText('Discard unsaved changes?')
    const dialog = title.closest('dialog')
    if (dialog === null) throw new Error('confirm dialog missing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('loc').textContent).toBe('/devices')
    expect(screen.getByRole('heading', { name: 'Driveway' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'hero-open-other' }))
    const again = await screen.findByText('Discard unsaved changes?')
    const confirmDialog = again.closest('dialog')
    if (confirmDialog === null) throw new Error('confirm dialog missing')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/devices/9')
    })
  })

  it('navigates from the hero at once when nothing is dirty', async () => {
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'hero-open-other' }))
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/devices/9')
    })
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
  })

  it('opens on Device info, with no Detail tab, when the hero model covers nothing', () => {
    renderModal()
    openModal()
    expect(screen.getByRole('button', { name: 'Detail' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'hero-settled-empty' }))
    expect(screen.queryByRole('button', { name: 'Detail' })).toBeNull()
    expect(screen.queryByTestId('hero-card')).toBeNull()
    expect(screen.getByRole('button', { name: 'Device info' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'edit-name' }).closest('.hidden')).toBeNull()
  })
})
