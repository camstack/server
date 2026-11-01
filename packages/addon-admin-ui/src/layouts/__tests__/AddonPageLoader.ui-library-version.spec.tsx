/**
 * A page remote shares the host's ui-library and declares the lowest version it
 * was built against. A host older than that shows a message in the frame
 * instead of mounting the page; a host that satisfies it mounts the page.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../i18n'
import {
  declaredUiLibraryRanges,
  uiLibraryRequirementProblem,
} from '../page-ui-library-requirement'

const host = vi.hoisted(() => ({
  uiLibraryVersion: '1.2.300' as string | null,
}))
const shareScope = vi.hoisted(() => ({
  required: '>=1.2.368',
  map: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('@module-federation/runtime', () => ({
  registerRemotes: vi.fn(),
  loadRemote: vi.fn(async () => ({
    default: () => <div data-testid="remote-page">page</div>,
  })),
  getInstance: () => ({ shareScopeMap: { default: shareScope.map } }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    get uiLibraryVersion() {
      return host.uiLibraryVersion
    },
    useAddonPagesListPages: () => ({
      data: [
        {
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
        },
      ],
      isError: false,
      error: null,
    }),
    useSystem: () => ({ trpcClient: {} }),
    ensureMfHostInit: vi.fn(),
  }
})

import { AddonPageLoader } from '../AddonPageLoader'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/addon/studio']}>
      <Routes>
        <Route path="/addon/:pagePath" element={<AddonPageLoader />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  shareScope.map = {
    '@camstack/ui-library': {
      '1.2.368': {
        from: 'addon_model_studio_page',
        shareConfig: { requiredVersion: shareScope.required },
      },
    },
  }
})

describe('the page remote declares the ui-library it needs', () => {
  it('refuses to mount on a host whose ui-library is older', async () => {
    host.uiLibraryVersion = '1.2.300'
    renderPage()
    const error = await screen.findByTestId('addon-page-error')
    expect(error.textContent).toContain('1.2.368')
    expect(error.textContent).toContain('1.2.300')
    expect(screen.queryByTestId('remote-page')).toBeNull()
  })

  it('mounts the page on a host that satisfies it', async () => {
    host.uiLibraryVersion = '1.2.400'
    renderPage()
    await waitFor(() => expect(screen.getByTestId('remote-page')).toBeTruthy())
  })

  it('does not refuse when the host version is unknown', async () => {
    host.uiLibraryVersion = null
    renderPage()
    await waitFor(() => expect(screen.getByTestId('remote-page')).toBeTruthy())
  })
})

describe('requirement parsing', () => {
  it('reads only the declaration of the named remote', () => {
    const map = {
      '@camstack/ui-library': {
        a: { from: 'one', shareConfig: { requiredVersion: '>=2.0.0' } },
        b: { from: 'two', shareConfig: { requiredVersion: '>=9.0.0' } },
      },
    }
    expect(declaredUiLibraryRanges({ default: map }, 'one')).toEqual(['>=2.0.0'])
  })

  it('compares numerically, not as text', () => {
    expect(uiLibraryRequirementProblem('1.2.99', ['>=1.2.368'])).not.toBeNull()
    expect(uiLibraryRequirementProblem('1.10.0', ['>=1.9.0'])).toBeNull()
    expect(uiLibraryRequirementProblem('1.2.368', ['>=1.2.368'])).toBeNull()
    expect(uiLibraryRequirementProblem('1.2.1', ['*', 'false'])).toBeNull()
  })
})
