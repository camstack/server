/**
 * AddonCard — install-source badge (npm vs DEV) on the icon tile (Task 9).
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AddonListItem } from '../AddonCard'

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
    useAddonsGetVersions: () => ({ data: [], isLoading: false }),
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

function addon(installSource?: 'npm' | 'local' | 'upload'): AddonListItem {
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
    ...(installSource !== undefined ? { installSource } : {}),
  }
}

describe('AddonCard install-source badge', () => {
  it('shows npm mark when installSource is npm', () => {
    const { container } = render(<AddonCard addon={addon('npm')} />)
    expect(container.querySelector('.bg-\\[\\#cb3837\\]')).toBeTruthy()
    expect(screen.queryByText('DEV')).toBeNull()
  })

  it('shows npm mark when installSource is absent (registry default)', () => {
    const { container } = render(<AddonCard addon={addon()} />)
    expect(container.querySelector('.bg-\\[\\#cb3837\\]')).toBeTruthy()
    expect(screen.queryByText('DEV')).toBeNull()
  })

  it('shows DEV only for local installSource', () => {
    const { container } = render(<AddonCard addon={addon('local')} />)
    expect(screen.getByText('DEV')).toBeTruthy()
    expect(container.querySelector('.bg-\\[\\#cb3837\\]')).toBeNull()
  })
})
