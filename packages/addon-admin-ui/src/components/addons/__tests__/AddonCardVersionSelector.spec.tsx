/**
 * AddonCard — version selector for available updates (Bug 1).
 *
 * When an update is available the card renders the standard version
 * selector (dropdown of available npm versions, glowing) with an
 * "Update" button immediately to its LEFT that installs the SELECTED
 * version (default = latest available).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonListItem } from '../AddonCard'

// ---------------------------------------------------------------------------
// Mocks — declared before importing the card
// ---------------------------------------------------------------------------

let mockVersions: Array<{
  version: string
  publishedAt: string
  distTags: string[]
  deprecated: boolean
}> = []

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useAddonsGetAddonAutoUpdate: () => ({ data: undefined }),
    useAddonsSetAddonAutoUpdate: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsInstallPackage: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsRestartAddon: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsRetryLoad: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsUninstallPackage: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsGetVersions: () => ({ data: mockVersions, isLoading: false }),
    useConfirm: () => vi.fn().mockResolvedValue(true),
    useAlert: () => vi.fn().mockResolvedValue(undefined),
    useAddonsListInstallations: () => ({ data: undefined, refetch: vi.fn() }),
    useSystem: () => ({ trpcClient: {} }),
    LogStream: () => null,
    EventStream: () => null,
    DeviceExportPanel: () => null,
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

import { AddonCard } from '../AddonCard'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function addon(): AddonListItem {
  return {
    manifest: {
      id: 'addon-a',
      name: 'Addon A',
      version: '1.0.0',
      capabilities: [],
      packageName: '@camstack/addon-a',
      packageVersion: '1.0.0',
    },
    enabled: true,
    source: 'installed',
    installSource: 'npm',
  }
}

function renderCard(opts: { availableUpdate?: string; onUpdate?: (v: string) => void } = {}) {
  return render(
    <AddonCard
      addon={addon()}
      {...(opts.availableUpdate !== undefined ? { availableUpdate: opts.availableUpdate } : {})}
      {...(opts.onUpdate !== undefined ? { onUpdate: opts.onUpdate } : {})}
    />,
  )
}

describe('AddonCard version selector (update available)', () => {
  beforeEach(() => {
    mockVersions = [
      { version: '2.0.0', publishedAt: '2026-07-01', distTags: ['latest'], deprecated: false },
      { version: '1.5.0', publishedAt: '2026-06-01', distTags: [], deprecated: false },
      { version: '1.0.0', publishedAt: '2026-05-01', distTags: [], deprecated: false },
    ]
  })

  it('renders an Update button immediately to the LEFT of the version selector', () => {
    renderCard({ availableUpdate: '2.0.0', onUpdate: vi.fn() })
    const updateBtn = screen.getByRole('button', { name: /^update$/i })
    const selector = screen.getByRole('button', { name: /select version to install/i })
    expect(updateBtn).toBeTruthy()
    expect(selector).toBeTruthy()
    // DOM order: Update button precedes the selector (i.e. sits to its left)
    expect(
      updateBtn.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Same flex row container
    expect(updateBtn.parentElement).toBe(selector.parentElement)
  })

  it('the selector glows while an update is available and shows current + selected', () => {
    renderCard({ availableUpdate: '2.0.0', onUpdate: vi.fn() })
    const selector = screen.getByRole('button', { name: /select version to install/i })
    expect(selector.className).toContain('animate-pulse')
    // Defaults to the latest available; the current installed version stays visible
    expect(selector.textContent).toContain('2.0.0')
    expect(selector.textContent).toContain('1.0.0')
  })

  it('Update installs the latest available version by default', () => {
    const onUpdate = vi.fn()
    renderCard({ availableUpdate: '2.0.0', onUpdate })
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }))
    expect(onUpdate).toHaveBeenCalledWith('2.0.0')
  })

  it('Update installs the version SELECTED in the dropdown', () => {
    const onUpdate = vi.fn()
    renderCard({ availableUpdate: '2.0.0', onUpdate })
    // Open the version dropdown
    fireEvent.click(screen.getByRole('button', { name: /select version to install/i }))
    // Pick 1.5.0
    fireEvent.click(screen.getByRole('button', { name: /select 1\.5\.0/i }))
    // Selector now shows the picked version
    expect(
      screen.getByRole('button', { name: /select version to install/i }).textContent,
    ).toContain('1.5.0')
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }))
    expect(onUpdate).toHaveBeenCalledWith('1.5.0')
  })

  it('renders no Update button when no update is available', () => {
    renderCard({})
    expect(screen.queryByRole('button', { name: /^update$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /select version to install/i })).toBeNull()
  })
})
