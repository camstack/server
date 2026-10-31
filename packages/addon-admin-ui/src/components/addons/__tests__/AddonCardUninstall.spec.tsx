/**
 * AddonCard — uninstall reaches the node the page is scoped to, and
 * "Everywhere" reaches every node that has the package.
 *
 * Before 2026-10-08 the card called `uninstallPackage({ packageName })` and
 * nothing else, whatever node was selected — so a package could be removed
 * from the hub only, and its agent copies (decoder-ffmpeg on two agents) had
 * no button at all.
 */

import type { PackageInstallations, UninstallPackageResult } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonListItem } from '../AddonCard'

const PKG = '@camstack/addon-a'

const mutateAsync = vi.fn()
const confirmFn = vi.fn()
const alertFn = vi.fn()
let installations: PackageInstallations

function row(nodeId: string, isHub: boolean, isOnline = true) {
  return {
    packageName: PKG,
    nodeId,
    nodeName: isHub ? 'Hub' : nodeId,
    isHub,
    isOnline,
    version: '1.0.0',
    addonIds: ['addon-a'],
    source: isOnline ? ('live' as const) : ('recorded' as const),
    onHub: true,
  }
}

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
    useAddonsUninstallPackage: () => ({ mutateAsync, isPending: false }),
    useAddonsGetVersions: () => ({ data: [], isLoading: false }),
    useAddonsListInstallations: () => ({
      data: installations,
      refetch: async () => ({ data: installations }),
    }),
    useConfirm: () => confirmFn,
    useAlert: () => alertFn,
    useSystem: () => ({ trpcClient: {} }),
    LogStream: () => null,
    EventStream: () => null,
    DeviceExportPanel: () => null,
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

import { AddonCard } from '../AddonCard'

function addon(): AddonListItem {
  return {
    manifest: {
      id: 'addon-a',
      name: 'Addon A',
      version: '1.0.0',
      capabilities: [],
      packageName: PKG,
      packageVersion: '1.0.0',
    },
    enabled: true,
    source: 'installed',
    installSource: 'npm',
  }
}

function okResult(nodeIds: readonly string[]): UninstallPackageResult {
  return {
    success: true,
    packageName: PKG,
    results: nodeIds.map((nodeId) => ({
      nodeId,
      outcome: 'uninstalled' as const,
      addonIds: ['addon-a'],
      runnersStopped: ['addon-a'],
      warnings: [],
    })),
  }
}

describe('AddonCard uninstall', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
    confirmFn.mockReset().mockResolvedValue(true)
    alertFn.mockReset().mockResolvedValue(undefined)
    installations = {
      installations: [row('hub', true), row('agent-a', false), row('mac', false, false)],
      unreachable: [],
    }
  })

  it('on an agent, Uninstall removes the package from THAT agent only', async () => {
    mutateAsync.mockResolvedValue(okResult(['agent-a']))
    render(
      <AddonCard addon={addon()} selectedNode={{ id: 'agent-a', name: 'agent-a', isHub: false }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
    expect(mutateAsync).toHaveBeenCalledWith({ packageName: PKG, nodeId: 'agent-a' })
    await waitFor(() => expect(alertFn).toHaveBeenCalled())
    expect(alertFn.mock.calls[0]?.[0].message).toContain('agent-a: uninstalled')
  })

  it('on the hub, Uninstall keeps the hub-only call', async () => {
    mutateAsync.mockResolvedValue(okResult(['hub']))
    render(<AddonCard addon={addon()} selectedNode={{ id: 'hub', name: 'Hub', isHub: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ packageName: PKG }))
  })

  it('Everywhere confirms with every holder listed, then uninstalls everywhere', async () => {
    mutateAsync.mockResolvedValue(okResult(['agent-a', 'hub']))
    render(<AddonCard addon={addon()} selectedNode={{ id: 'hub', name: 'Hub', isHub: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /everywhere \(3\)/i }))
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    const message: string = confirmFn.mock.calls[0]?.[0].message
    expect(message).toContain('- Hub 1.0.0')
    expect(message).toContain('- agent-a 1.0.0')
    expect(message).toContain('- mac 1.0.0 (offline')
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ packageName: PKG, everywhere: true }),
    )
  })

  it('a declined confirm removes nothing', async () => {
    confirmFn.mockResolvedValue(false)
    render(<AddonCard addon={addon()} selectedNode={{ id: 'hub', name: 'Hub', isHub: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /everywhere/i }))
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('a per-node failure is reported as such, not as a success', async () => {
    mutateAsync.mockResolvedValue({
      success: false,
      packageName: PKG,
      results: [
        {
          nodeId: 'agent-a',
          outcome: 'failed',
          error: 'status read failed: timeout',
          addonIds: [],
          runnersStopped: [],
          warnings: [],
        },
      ],
    } satisfies UninstallPackageResult)
    render(
      <AddonCard addon={addon()} selectedNode={{ id: 'agent-a', name: 'agent-a', isHub: false }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^uninstall$/i }))
    await waitFor(() => expect(alertFn).toHaveBeenCalled())
    const shown = alertFn.mock.calls[0]?.[0]
    expect(shown.variant).toBe('danger')
    expect(shown.message).toContain('agent-a: FAILED')
    expect(shown.message).toContain('status read failed: timeout')
  })
})
