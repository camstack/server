/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

vi.mock('../tabs/StorageLocationsPanel', () => ({
  StorageLocationsPanel: () => <div data-testid="storage-panel" />,
}))

const updateScoped = vi.fn()
const updateGlobal = vi.fn()
const idle = { isPending: false, isError: false, isSuccess: false }
const NODES = [
  { id: 'hub', name: 'Hub', isHub: true, isOnline: true, localIps: [], addons: [] },
  { id: 'agent-a', name: 'agent-a', isHub: false, isOnline: true, localIps: [], addons: [] },
]

interface ScopedQuery {
  readonly addonId: string
  readonly cap: string
  readonly scope: string
}
const scopedQueries: ScopedQuery[] = []
const FORMS: Readonly<Record<string, { readonly key: string; readonly value: string }>> = {
  recorder: { key: 'recordingNodeId', value: 'agent-a' },
  'pipeline-analytics': { key: 'postProcessingNodeId', value: 'agent-a' },
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useClusterNodes: () => ({ nodes: NODES }),
    useAddonSettingsGetScopedSettings: (input: ScopedQuery) => {
      scopedQueries.push(input)
      const form = FORMS[input.addonId]
      return {
        isLoading: false,
        data: form
          ? {
              sections: [
                {
                  id: 'cluster',
                  title: 'Cluster',
                  fields: [{ type: 'text', key: form.key, label: form.key, value: form.value }],
                },
              ],
            }
          : null,
      }
    },
    useAddonSettingsUpdateScopedSettings: () => ({ ...idle, mutate: updateScoped }),
    useAddonSettingsGetGlobalSettings: () => ({ isLoading: false, data: undefined }),
    useAddonSettingsUpdateGlobalSettings: () => ({ ...idle, mutate: updateGlobal }),
  }
})

import { ClusterEventsTab } from '../tabs/ClusterEventsTab'
import { ClusterRecordingTab } from '../tabs/ClusterRecordingTab'

function renderTab(node: React.ReactNode): void {
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
}

describe('Cluster → Events post-processing node', () => {
  it('shows the node the analytics cluster form stores and writes the picked one back there', () => {
    renderTab(<ClusterEventsTab />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('agent-a')
    expect(scopedQueries).toContainEqual({
      addonId: 'pipeline-analytics',
      cap: 'pipeline-analytics',
      scope: 'cluster',
    })
    fireEvent.change(select, { target: { value: 'hub' } })
    expect(updateScoped).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      cap: 'pipeline-analytics',
      scope: 'cluster',
      patch: { postProcessingNodeId: 'hub' },
    })
    expect(updateGlobal).not.toHaveBeenCalled()
  })
})

describe('Cluster → Recording node', () => {
  it('shows the node the recorder cluster form stores and writes the picked one back there', () => {
    updateScoped.mockClear()
    renderTab(<ClusterRecordingTab />)
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(select.value).toBe('agent-a')
    expect(scopedQueries).toContainEqual({
      addonId: 'recorder',
      cap: 'recording',
      scope: 'cluster',
    })
    fireEvent.change(select, { target: { value: 'hub' } })
    expect(updateScoped).toHaveBeenCalledWith({
      addonId: 'recorder',
      cap: 'recording',
      scope: 'cluster',
      patch: { recordingNodeId: 'hub' },
    })
    expect(updateGlobal).not.toHaveBeenCalled()
  })
})
