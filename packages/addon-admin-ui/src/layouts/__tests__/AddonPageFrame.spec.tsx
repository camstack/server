/**
 * An addon page that is still loading, or that throws, stays inside the shell.
 *
 * The admin UI had no error boundary: one throw in a Module Federation remote
 * unmounted the whole root and the operator got a blank page without the
 * sidebar. These render a stand-in shell (sidebar + main) around the real
 * `AddonPageBoundary` and assert the chrome survives both states.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lazy, type ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { AddonPageBoundary } from '../AddonPageFrame'

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <div>
      <nav aria-label="sidebar">Devices</nav>
      <main data-testid="main">{children}</main>
    </div>
  )
}

function Throws(): ReactNode {
  throw new Error('the remote blew up')
}

const NeverLoads = lazy(() => new Promise<{ default: () => ReactNode }>(() => undefined))

describe('AddonPageBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading state inside <main> while the page suspends', () => {
    render(
      <Shell>
        <AddonPageBoundary pageKey="model-studio">
          <NeverLoads />
        </AddonPageBoundary>
      </Shell>,
    )
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeTruthy()
    const loading = screen.getByTestId('addon-page-loading')
    expect(screen.getByTestId('main').contains(loading)).toBe(true)
    expect(loading.getAttribute('role')).toBe('status')
  })

  it('shows a crashing page as an error inside <main>, not a blank app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <Shell>
        <AddonPageBoundary pageKey="model-studio">
          <Throws />
        </AddonPageBoundary>
      </Shell>,
    )
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeTruthy()
    const error = screen.getByTestId('addon-page-error')
    expect(screen.getByTestId('main').contains(error)).toBe(true)
    expect(error.textContent).toContain('the remote blew up')
  })

  it('clears a crash when the operator moves to another page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <AddonPageBoundary pageKey="model-studio">
        <Throws />
      </AddonPageBoundary>,
    )
    expect(screen.getByTestId('addon-page-error')).toBeTruthy()
    rerender(
      <AddonPageBoundary pageKey="benchmark">
        <span>benchmark page</span>
      </AddonPageBoundary>,
    )
    expect(screen.queryByTestId('addon-page-error')).toBeNull()
    expect(screen.getByText('benchmark page')).toBeTruthy()
  })
})

describe('AddonPageLoader', () => {
  const src = readFileSync(join(__dirname, '..', 'AddonPageLoader.tsx'), 'utf-8')

  it('renders the remote page only inside AddonPageBoundary', () => {
    const boundaryAt = src.indexOf('<AddonPageBoundary')
    const pageAt = src.indexOf('<PageComponent')
    expect(boundaryAt).toBeGreaterThanOrEqual(0)
    expect(pageAt).toBeGreaterThan(boundaryAt)
    expect(src.slice(boundaryAt, pageAt)).not.toContain('</AddonPageBoundary>')
  })

  it('draws its own loading and error states with the shared frame, never full-screen', () => {
    expect(src).toContain('<AddonPageLoading />')
    expect(src).toContain('<AddonPageError')
    expect(src).not.toMatch(/min-h-screen|h-screen/)
  })
})
