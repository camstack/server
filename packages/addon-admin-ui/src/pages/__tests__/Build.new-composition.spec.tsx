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
        fieldPath: 'celsius',
      },
    ],
  })
  if (!compiled.ok) throw new Error('helper fixture did not compile')
  return answered(
    block({
      id: 'blk-veranda',
      name: 'Veranda',
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
                  fieldPath: 'celsius',
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

  it('clicking New composition opens the helper / blank chooser and leaves it open', async () => {
    renderAt('/build?tab=custom-device', <BuildPage />)
    expect(screen.getByTestId('build-new').textContent).toContain('New composition')

    fireEvent.click(screen.getByTestId('build-new'))

    expect(await screen.findByTestId('blank-composition')).toBeTruthy()
    expect(screen.getByTestId('new-helper')).toBeTruthy()
    expect(window.location.search).toContain('new=1')
    expect(window.location.search).toContain('tab=custom-device')
    expect(screen.getByTestId('blank-composition')).toBeTruthy()
  })

  it('opens the same chooser from /build/compositions/new', async () => {
    renderAt(
      '/build/compositions/new',
      <Routes>
        <Route path="/build/compositions/new" element={<CompositionEditorPage />} />
        <Route path="/build/compositions/:blockId" element={<CompositionEditorPage />} />
        <Route path="/build" element={<BuildPage />} />
      </Routes>,
    )
    expect(await screen.findByTestId('blank-composition')).toBeTruthy()
    expect(screen.getByTestId('new-helper')).toBeTruthy()
    expect(window.location.pathname).toBe('/build')
    expect(window.location.search).toContain('tab=custom-device')
    expect(window.location.search).toContain('new=1')
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
