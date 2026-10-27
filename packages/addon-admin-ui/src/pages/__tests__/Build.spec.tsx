/**
 * Build-your-self header — SectionedPage tabs switch `?tab=` and clear the
 * per-tab editor params (`block`, `create`) via `ownedParams`, so a
 * middle-click / pasteable link cannot reopen a stale editor on the wrong
 * section.
 */
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        coreBlocks: {
          list: { query: async () => ({ blocks: [] }) },
          listCompositions: { query: async () => ({ state: 'loaded' as const, views: [] }) },
        },
      },
    }),
  }
})

vi.mock('../build/AutomationsTab', () => ({
  AutomationsTab: () => <div data-testid="automations-body">automations</div>,
}))
vi.mock('../build/ScriptsTab', () => ({
  ScriptsTab: () => <div data-testid="scripts-body">scripts</div>,
}))
vi.mock('../build/CustomDeviceTab', () => ({
  CustomDeviceTab: () => <div data-testid="custom-device-body">custom-device</div>,
}))

import { BuildPage } from '../Build'

function LocationProbe(): ReactElement {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

function renderBuild(initialEntry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ConfirmDialogProvider>
          <BuildPage />
        </ConfirmDialogProvider>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('BuildPage section tabs', () => {
  it('renders a tablist and switching to Scripts sets tab=scripts, clearing block, create and new', () => {
    renderBuild('/build?tab=automations&block=blk-1&create=1&new=1&keep=yes')

    expect(screen.getByRole('tablist', { name: 'Build-your-self sections' })).toBeTruthy()

    const automations = screen.getByTestId('section-automations')
    expect(automations.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByTestId('section-scripts'))

    const location = screen.getByTestId('location').textContent ?? ''
    expect(location).toContain('tab=scripts')
    expect(location).not.toContain('block=')
    expect(location).not.toContain('create=')
    expect(location).not.toContain('new=')
    expect(location).toContain('keep=yes')
    expect(screen.getByTestId('section-scripts').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('scripts-body')).toBeTruthy()
  })

  it('keeps block when re-clicking the current tab; clears it when leaving the tab', () => {
    renderBuild('/build?tab=scripts&block=xyz')

    const scripts = screen.getByTestId('section-scripts')
    expect(scripts.getAttribute('aria-selected')).toBe('true')

    fireEvent.click(scripts)
    expect(screen.getByTestId('location').textContent).toContain('block=xyz')
    expect(screen.getByTestId('location').textContent).toContain('tab=scripts')

    fireEvent.click(screen.getByTestId('section-automations'))
    const afterLeave = screen.getByTestId('location').textContent ?? ''
    expect(afterLeave).toContain('tab=automations')
    expect(afterLeave).not.toContain('block=')
  })
})
