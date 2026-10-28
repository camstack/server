/**
 * Header "New composition" lands on the chooser (Helper / Blank) and stays
 * there. The create flag used to be cleared by a router write that did not
 * see `new=1` (written with history.replaceState), so the dialog closed in
 * the same turn.
 */
import { compileHelper, type CompositionView, type CoreBlock, DeviceType } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

let views: readonly CompositionView[] = []
let editorView: CompositionView | null = null

vi.mock('../build/AutomationsTab', () => ({
  AutomationsTab: () => <div data-testid="automations-body" />,
}))
vi.mock('../build/actions/ActionsTab', () => ({
  ActionsTab: () => <div data-testid="actions-body">actions</div>,
}))
vi.mock('../build/ScriptsTab', () => ({
  ScriptsTab: () => <div data-testid="scripts-body" />,
}))

vi.mock('../../hooks/useDevice', () => ({
  useDeviceList: () => ({ data: [], error: null }),
}))

vi.mock('../../components/device/customize/assignments/use-cap-index', () => ({
  useCapIndex: () => ({ kind: 'pending' as const }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        actions: { list: { query: async () => [] } },
        coreBlocks: {
          list: { query: async () => ({ blocks: [] }) },
          listCompositions: { query: async () => ({ state: 'loaded' as const, views: [] }) },
        },
      },
    }),
    useCoreBlocksListCompositions: () => ({
      data: { state: 'loaded' as const, views },
      error: null,
      refetch: async () => undefined,
    }),
    useCoreBlocksCreateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCoreBlocksDelete: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useCoreBlocksGetComposition: () => ({
      status: 'success' as const,
      data: { state: 'loaded' as const, view: editorView },
      error: null,
      refetch: async () => undefined,
    }),
    useDeviceManagerListAll: () => ({ data: [], status: 'success' as const, error: null }),
    useIntegrationsList: () => ({ data: [], status: 'success' as const, error: null }),
    useDeviceStateGetCapSlice: () => ({ status: 'pending' as const, data: undefined, error: null }),
    useDeviceStateGetSnapshot: () => ({ status: 'pending' as const, data: undefined, error: null }),
    useDeviceManagerGetWireableFields: () => ({
      status: 'pending' as const,
      data: undefined,
      error: null,
    }),
    useDeviceCapSlice: () => undefined,
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerListPersistedByAddon: () => ({
      data: [],
      refetch: async () => ({ data: [] }),
    }),
    useUiText: () => (key: string, fallback?: string) => fallback ?? key,
    deviceTypeMetaOf: () => ({ label: 'Sensor' }),
    deviceRoleMetaOf: () => ({ label: 'Temperature' }),
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { BuildPage } from '../Build'
import { CompositionEditorPage } from '../CompositionEditorPage'

function block(over: Partial<CoreBlock>): CoreBlock {
  return {
    id: 'b',
    name: 'Block',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: 'running',
    lastChangedAt: 1,
    ...over,
  }
}

function answered(viewBlock: CoreBlock, deviceId: number): CompositionView {
  return {
    block: viewBlock,
    state: {
      kind: 'answered',
      state: { blockId: viewBlock.id, deviceId, status: 'running', fields: [] },
    },
  }
}

function helperView(): CompositionView {
  const compiled = compileHelper({
    kind: 'group',
    templateId: 'temperature',
    aggregate: 'mean',
    members: [
      {
        source: { addonId: 'provider-homeassistant', stableId: 'sensor.porch' },
        cap: 'temperature-sensor',
        fieldPath: 'temperature',
      },
    ],
  })
  if (!compiled.ok) throw new Error('helper fixture did not compile')
  return answered(
    block({
      id: 'blk-veranda',
      name: 'Front door',
      source: { kind: 'composition', composition: compiled.composition },
    }),
    910,
  )
}

function plainView(): CompositionView {
  return answered(
    block({
      id: 'porch',
      name: 'Porch',
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'new', type: DeviceType.Sensor },
          features: [
            {
              kind: 'fields',
              cap: 'temperature-sensor',
              fields: {
                celsius: {
                  kind: 'from',
                  source: { addonId: 'provider-homeassistant', stableId: 'porch-temp' },
                  cap: 'temperature-sensor',
                  fieldPath: 'temperature',
                },
              },
            },
          ],
        },
      },
    }),
    4603,
  )
}

function renderAt(path: string, child: ReactNode): void {
  window.history.replaceState(null, '', path)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <BrowserRouter>{child}</BrowserRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
  render(ui)
}

describe('Build New composition', () => {
  beforeEach(() => {
    views = []
    editorView = null
    window.history.replaceState(null, '', '/build?tab=custom-device')
  })

  it('one New composed device button opens the picker with Group, Calculation and Advanced', async () => {
    renderAt('/build?tab=custom-device', <BuildPage />)
    expect(screen.getByTestId('build-new-composed').textContent).toContain('New composed device')
    expect(screen.queryByTestId('build-new-helper')).toBeNull()
    expect(screen.queryByTestId('build-new-composition')).toBeNull()

    fireEvent.click(screen.getByTestId('build-new-composed'))

    expect(await screen.findByTestId('helper-template-picker')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(window.location.search).toContain('new=helper')
    // Group section: readings, no separate sum tile (a sum is an aggregation).
    expect(screen.getByTestId('helper-template-temperature')).toBeTruthy()
    expect(screen.getByTestId('helper-template-power')).toBeTruthy()
    expect(screen.queryByTestId('helper-template-sum')).toBeNull()
    // Calculation section.
    for (const id of ['threshold', 'difference', 'ratio', 'derivative', 'statistic', 'integral']) {
      expect(screen.getByTestId(`helper-template-${id}`)).toBeTruthy()
    }
    // Advanced section.
    expect(screen.getByTestId('helper-template-composition')).toBeTruthy()
    expect(screen.getByTestId('helper-template-expression')).toBeTruthy()
    expect(screen.getByText('Calculation')).toBeTruthy()
    expect(screen.getByText('Advanced')).toBeTruthy()
    expect(screen.getByText('Group · Readings')).toBeTruthy()
  })

  it('Advanced > Free composition opens the free composition form', async () => {
    renderAt('/build?tab=custom-device', <BuildPage />)
    fireEvent.click(screen.getByTestId('build-new-composed'))
    fireEvent.click(await screen.findByTestId('helper-template-composition'))
    expect(await screen.findByTestId('blank-composition-form')).toBeTruthy()
    expect(screen.queryByTestId('helper-template-picker')).toBeNull()
  })

  it('the legacy new=blank link still opens the free composition form', async () => {
    renderAt('/build?tab=custom-device&new=blank', <BuildPage />)
    expect(await screen.findByTestId('blank-composition-form')).toBeTruthy()
  })

  it('lists a group, a calculation and a free composition with their type badge', async () => {
    views = [helperView(), plainView()]
    renderAt('/build?tab=custom-device', <BuildPage />)
    const badges = await screen.findAllByTestId('composed-origin-badge')
    expect(badges.map((b) => b.textContent).sort()).toEqual(['Advanced', 'Group: Temperature'])
  })

  it('names the dialog after the chosen helper type', async () => {
    renderAt('/build?tab=custom-device', <BuildPage />)
    fireEvent.click(screen.getByTestId('build-new-composed'))
    fireEvent.click(await screen.findByTestId('helper-template-temperature'))
    expect(await screen.findByRole('heading', { name: 'New temperature sensor' })).toBeTruthy()
    // The type is fixed once chosen: no way back to the tiles.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.queryByTestId('helper-template-light')).toBeNull()
  })

  it('opens the helper type tiles from /build/compositions/new', async () => {
    renderAt(
      '/build/compositions/new',
      <Routes>
        <Route path="/build/compositions/new" element={<CompositionEditorPage />} />
        <Route path="/build/compositions/:blockId" element={<CompositionEditorPage />} />
        <Route path="/build" element={<BuildPage />} />
      </Routes>,
    )
    expect(await screen.findByTestId('helper-template-picker')).toBeTruthy()
    expect(window.location.pathname).toBe('/build')
    expect(window.location.search).toContain('tab=custom-device')
    expect(window.location.search).toContain('new=helper')
  })

  it('Edit opens a helper as its wizard', async () => {
    const view = helperView()
    views = [view]
    editorView = view
    renderAt('/build?tab=custom-device', <BuildPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByTestId('helper-wizard')).toBeTruthy()
    expect(screen.getByTestId('composed-device-editor')).toBeTruthy()
  })

  it('Edit opens an existing composition, and Change opens its field editor', async () => {
    const view = plainView()
    views = [view]
    editorView = view
    renderAt('/build?tab=custom-device', <BuildPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const change = await screen.findByRole('button', { name: 'Change' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(change)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
  })
})
