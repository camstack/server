/**
 * A throw in the content area (the page route itself, not only a remote) stays
 * inside <main>: the React root has no other error boundary, so before this one
 * a throw outside AddonPageBoundary (the loader's own code, any route) blanked
 * the whole app, sidebar included.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ShellContentBoundary } from '../AddonPageFrame'

function Throws(): ReactNode {
  throw new Error('route blew up')
}

describe('ShellContentBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps a throwing route inside <main>', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <div>
        <nav aria-label="sidebar">Devices</nav>
        <main data-testid="main">
          <ShellContentBoundary resetKey="/devices">
            <Throws />
          </ShellContentBoundary>
        </main>
      </div>,
    )
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeTruthy()
    expect(screen.getByTestId('main').contains(screen.getByTestId('addon-page-error'))).toBe(true)
  })

  it('wraps the keep-alive outlet in AppLayout', () => {
    const layout = readFileSync(join(__dirname, '..', 'AppLayout.tsx'), 'utf-8')
    const boundaryAt = layout.indexOf('<ShellContentBoundary')
    expect(boundaryAt).toBeGreaterThanOrEqual(0)
    expect(layout.indexOf('<KeepAliveOutlet')).toBeGreaterThan(boundaryAt)
  })
})
