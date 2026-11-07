/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

// The events folder is the `eventMedia` storage location: it is managed on
// Recordings → Events (next to the event store it holds), not among the cluster
// roles. A marker stands in for the storage panel so its presence is visible.
vi.mock('../tabs/StorageLocationsPanel', () => ({
  StorageLocationsPanel: ({ types }: { readonly types: readonly string[] }) => (
    <div data-testid="storage-panel">{types.join(',')}</div>
  ),
}))

const idle = { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false }
const updateGlobal = vi.fn()
const updateScoped = vi.fn()
interface ScopedQuery {
  readonly addonId: string
  readonly cap: string
  readonly scope: string
}
/** The cluster forms the recorder and the analytics addon serve, one marked value each. */
function scopedForm(input: ScopedQuery) {
  const key =
    input.addonId === 'recorder'
      ? 'recordingNodeId'
      : input.addonId === 'pipeline-analytics'
        ? 'postProcessingNodeId'
        : null
  if (key === null) return null
  return {
    sections: [
      {
        id: 'cluster',
        title: 'Cluster',
        fields: [{ type: 'text', key, label: key, value: 'MacMiniAgent.localdomain' } as const],
      },
    ],
  }
}
const setCapabilities = vi.fn()
const NODES = [
  { id: 'hub', name: 'Hub', isHub: true, isOnline: true, localIps: ['192.0.2.10'], addons: [] },
  {
    id: 'MacMiniAgent.localdomain',
    name: 'macmini',
    isHub: false,
    isOnline: true,
    localIps: ['192.0.2.40'],
    addons: [],
  },
]
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useClusterNodes: () => ({ nodes: NODES }),
    usePipelineOrchestratorListAgentSettings: () => ({ data: [], isLoading: false }),
    useAddonSettingsGetGlobalSettings: () => ({ data: undefined, isLoading: false }),
    useAddonSettingsUpdateGlobalSettings: () => ({ ...idle, mutate: updateGlobal }),
    useAddonSettingsGetScopedSettings: (input: ScopedQuery) => ({
      data: scopedForm(input),
      isLoading: false,
    }),
    useAddonSettingsUpdateScopedSettings: () => ({ ...idle, mutate: updateScoped }),
    usePipelineOrchestratorSetAgentCapabilities: () => ({ ...idle, mutate: setCapabilities }),
  }
})

import { ClusterRolesNodesTab } from '../tabs/ClusterRolesNodesTab'

function renderTab(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClusterRolesNodesTab />
    </QueryClientProvider>,
  )
}

describe('Cluster → Roles & nodes', () => {
  it('shows the cluster roles and the node capabilities as two section cards', () => {
    renderTab()
    expect(screen.getByRole('region', { name: 'Cluster roles' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Node capabilities' })).toBeInTheDocument()
  })

  it('a role is picked with the library select, nodes by name, and writes the node id', () => {
    renderTab()
    const select = screen.getByLabelText('Audio node') as HTMLSelectElement
    // The library Select: one bordered native select inside its own wrapper.
    expect(select.className).toMatch(/\bh-7\b/)
    expect(within(select).getByRole('option', { name: 'Hub (default)' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'macmini' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /localdomain/ })).toBeNull()
    fireEvent.change(select, { target: { value: 'MacMiniAgent.localdomain' } })
    expect(updateScoped).toHaveBeenCalledWith({
      addonId: 'pipeline-orchestrator',
      cap: 'pipeline-orchestrator',
      scope: 'cluster',
      patch: { audioNode: 'MacMiniAgent.localdomain' },
    })
    expect(updateGlobal).not.toHaveBeenCalled()
  })

  it('the recording and post-processing roles read the cluster form of their own capability', () => {
    renderTab()
    expect((screen.getByLabelText('Recording node') as HTMLSelectElement).value).toBe(
      'MacMiniAgent.localdomain',
    )
    expect((screen.getByLabelText('Post-processing node') as HTMLSelectElement).value).toBe(
      'MacMiniAgent.localdomain',
    )
  })

  it('writes the recording and post-processing roles through the scoped cluster write', () => {
    renderTab()
    fireEvent.change(screen.getByLabelText('Recording node'), { target: { value: 'hub' } })
    expect(updateScoped).toHaveBeenCalledWith({
      addonId: 'recorder',
      cap: 'recording',
      scope: 'cluster',
      patch: { recordingNodeId: 'hub' },
    })
    fireEvent.change(screen.getByLabelText('Post-processing node'), { target: { value: 'hub' } })
    expect(updateScoped).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      cap: 'pipeline-analytics',
      scope: 'cluster',
      patch: { postProcessingNodeId: 'hub' },
    })
    // The orchestrator roles keep the old write: its override runs the ingest re-derive.
    expect(updateGlobal).not.toHaveBeenCalledWith(expect.objectContaining({ addonId: 'recorder' }))
  })

  it('the node table is the shared DataTable with a compact switch per capability', () => {
    renderTab()
    const card = screen.getByRole('region', { name: 'Node capabilities' })
    expect(
      within(card)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([expect.stringMatching(/Node/), 'Detect', 'Audio'])
    // A node with no stored flag is on; only an explicit false turns it off.
    const macDetect = within(card).getByRole('switch', { name: 'Detect on macmini' })
    expect(macDetect).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(macDetect)
    expect(setCapabilities).toHaveBeenCalledWith({
      agentNodeId: 'MacMiniAgent.localdomain',
      detect: false,
    })
    setCapabilities.mockClear()
    const macAudio = within(card).getByRole('switch', { name: 'Audio on macmini' })
    expect(macAudio).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(macAudio)
    expect(setCapabilities).toHaveBeenCalledWith({
      agentNodeId: 'MacMiniAgent.localdomain',
      audio: false,
    })
  })

  it('carries no events folder — that storage location lives on Recordings → Events', () => {
    renderTab()
    expect(screen.queryByText('Events folder')).not.toBeInTheDocument()
    expect(screen.queryByTestId('storage-panel')).not.toBeInTheDocument()
  })
})
