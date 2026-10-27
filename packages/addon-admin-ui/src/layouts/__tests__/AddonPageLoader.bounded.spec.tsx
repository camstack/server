/**
 * An addon page whose load never settles becomes a bounded, in-frame state with
 * a message — never an endless skeleton. The pages list failing or hanging is
 * the same: a message inside <main>, with the sidebar stand-in still mounted.
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import '../../i18n'

const pagesQuery = vi.hoisted(() => ({
  current: { data: undefined, isError: false, error: null } as {
    data: unknown
    isError: boolean
    error: { message: string } | null
  },
}))

vi.mock('@module-federation/runtime', () => ({
  registerRemotes: vi.fn(),
  // The remote's entry never answers.
  loadRemote: vi.fn(() => new Promise(() => undefined)),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useAddonPagesListPages: () => pagesQuery.current,
    useSystem: () => ({ trpcClient: {} }),
    ensureMfHostInit: vi.fn(),
  }
})

import { ADDON_PAGE_LOAD_TIMEOUT_MS, AddonPageLoader } from '../AddonPageLoader'

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <div>
      <nav aria-label="sidebar">Devices</nav>
      <main data-testid="main">{children}</main>
    </div>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Shell>
        <Routes>
          <Route path="/addon/:pagePath" element={<AddonPageLoader />} />
        </Routes>
      </Shell>
    </MemoryRouter>,
  )
}

const PAGE = {
  addonId: 'model-studio',
  bundleUrl: '/addons/model-studio/remoteEntry.js',
  page: {
    id: 'studio',
    label: 'Studio',
    icon: 'box',
    path: '/addon/studio',
    remoteName: 'addon_model_studio_page',
    bundle: 'remoteEntry.js',
  },
}

describe('AddonPageLoader is bounded', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns a remote that never resolves into an in-frame message', async () => {
    pagesQuery.current = { data: [PAGE], isError: false, error: null }
    renderAt('/addon/studio')
    expect(screen.getByTestId('addon-page-loading')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADDON_PAGE_LOAD_TIMEOUT_MS + 100)
    })
    expect(screen.queryByTestId('addon-page-loading')).toBeNull()
    const error = screen.getByTestId('addon-page-error')
    expect(screen.getByTestId('main').contains(error)).toBe(true)
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeTruthy()
  })

  it('shows the failure of the pages list instead of a skeleton forever', () => {
    pagesQuery.current = { data: undefined, isError: true, error: { message: 'hub said no' } }
    renderAt('/addon/studio')
    expect(screen.getByTestId('addon-page-error').textContent).toContain('hub said no')
  })

  it('bounds a pages list that never answers', async () => {
    pagesQuery.current = { data: undefined, isError: false, error: null }
    renderAt('/addon/studio')
    expect(screen.getByTestId('addon-page-loading')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ADDON_PAGE_LOAD_TIMEOUT_MS + 100)
    })
    expect(screen.getByTestId('addon-page-error')).toBeTruthy()
  })
})
