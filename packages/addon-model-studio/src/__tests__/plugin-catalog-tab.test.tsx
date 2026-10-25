// @vitest-environment jsdom
/**
 * plugin catalog Sources — Catalog-style family cards + Import `{ manifestId }`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import type { ModelCatalogEntry } from '@camstack/types'
import ModelStudioPage from '../page.js'
import { PluginCatalogTab } from '../tabs/PluginCatalogTab.js'
import { OperationModalProvider } from '../components/OperationModalProvider.js'
import type { PluginCatalogCatalogDriftView, PluginCatalogCatalogEntryView } from '../ui/api.js'

vi.mock('../components/NodeSelector.js', () => ({
  NodeSelector: ({ selectedNodeId }: { selectedNodeId: string }) => (
    <div data-testid="node-selector">{selectedNodeId}</div>
  ),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useClusterNodes: () => ({
      nodes: [{ id: 'hub', name: 'Hub', shortName: 'hub', isOnline: true }],
    }),
  }
})

const SHA = 'a'.repeat(64)

function modelEntry(
  id: string,
  format: PluginCatalogCatalogEntryView['format'],
  sizeMB: number,
): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: `${id} — imported from the local plugin catalog YOLO catalog.`,
    formats: {
      [format]: { url: `camstack-local://${id}/artifact`, sizeMB, runtimes: ['python'] },
    },
    inputSize: { width: 320, height: 320 },
    labels: [
      { id: 'person', name: 'person' },
      { id: 'vehicle', name: 'vehicle' },
      { id: 'animal', name: 'animal' },
    ],
  }
}

function catalogEntry(
  over: Partial<PluginCatalogCatalogEntryView> &
    Pick<PluginCatalogCatalogEntryView, 'id' | 'label'>,
): PluginCatalogCatalogEntryView {
  const format = over.format ?? 'onnx'
  const precision = over.precision ?? 'fp32'
  return {
    family: 'yolov9s',
    variant: 'relu',
    format,
    precision,
    inputSize: { width: 320, height: 320 },
    files: [
      {
        relativePath: `${format}/scrypted_${over.id}.bin`,
        size: 8_500_000,
        sha256: SHA,
      },
    ],
    model: modelEntry(over.id, format, 8.5),
    ...over,
  }
}

const CATALOG: readonly PluginCatalogCatalogEntryView[] = [
  catalogEntry({
    id: 'scrypted-yolov9s-relu-onnx',
    label: 'plugin catalog YOLOv9S ReLU ONNX',
    format: 'onnx',
    precision: 'fp32',
  }),
  catalogEntry({
    id: 'scrypted-yolov9s-relu-openvino',
    label: 'plugin catalog YOLOv9S ReLU OpenVINO',
    format: 'openvino',
    precision: 'fp32',
  }),
  catalogEntry({
    id: 'scrypted-yolov9t-relu-coreml',
    label: 'plugin catalog YOLOv9T ReLU CoreML',
    family: 'yolov9t',
    format: 'coreml',
    precision: 'fp16',
  }),
]

interface Harness {
  readonly calls: { action: string; input: unknown }[]
  catalog: readonly PluginCatalogCatalogEntryView[]
  drift: readonly PluginCatalogCatalogDriftView[]
  /** Library registry — authority for the "imported" badge. */
  registered: readonly { stepId: string; entry: ModelCatalogEntry }[]
  listError: Error | null
  registryError: Error | null
  importImpl: (input: unknown) => Promise<unknown>
}

function makeHarness(over: Partial<Harness> = {}): Harness {
  return {
    calls: [],
    catalog: CATALOG,
    drift: CATALOG.map((row) => ({ manifestId: row.id, status: 'ok' as const })),
    registered: [],
    listError: null,
    registryError: null,
    importImpl: async (input) => ({
      stepId: 'object-detection',
      entry: modelEntry((input as { manifestId: string }).manifestId, 'onnx', 8.5),
    }),
    ...over,
  }
}

function fakeTrpc(harness: Harness): AddonPageProps['trpc'] {
  const surface = {
    addons: {
      custom: {
        mutate: async (input: { addonId: string; action: string; input: unknown }) => {
          harness.calls.push({ action: input.action, input: input.input })
          if (input.action === 'listCustomModels') {
            if (harness.registryError) throw harness.registryError
            return harness.registered
          }
          if (input.action === 'listAvailability') return {}
          if (input.action === 'listPluginCatalogCatalog') {
            if (harness.listError) throw harness.listError
            return { entries: harness.catalog, drift: harness.drift }
          }
          if (input.action === 'importPluginCatalogCatalogModel') {
            return harness.importImpl(input.input)
          }
          if (input.action === 'ensureModelFormats') {
            return { conversions: [] }
          }
          if (input.action === 'ensureFormatsThenDistribute') {
            return { conversions: [], distributed: [] }
          }
          if (input.action === 'listPlusCatalogCatalog') return []
          if (input.action === 'plusCatalogPlusStatus') return { configured: false }
          throw new Error(`unexpected action ${input.action}`)
        },
      },
    },
    pipelineExecutor: {
      getSchema: {
        query: async () => ({ slots: [], availableEngines: [], selectedEngine: {} }),
      },
    },
  }
  return surface as unknown as AddonPageProps['trpc']
}

afterEach(cleanup)

describe('Model Studio page — plugin catalog lives under Catalog', () => {
  it('has no standalone plugin catalog tab; Catalog → plugin catalog shows the catalog', async () => {
    window.history.replaceState(null, '', '/model-studio')
    render(
      <ModelStudioPage
        trpc={fakeTrpc(makeHarness())}
        theme={{ isDark: true }}
        navigate={() => undefined}
      />,
    )
    expect(screen.queryByRole('tab', { name: 'plugin catalog' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'plugin catalog' }))
    expect(await screen.findByTestId('plugin-catalog-tab')).toBeTruthy()
  })
})

describe('PluginCatalogTab — listing states', () => {
  it('shows a loading state while the catalog is in flight', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<{
      entries: readonly PluginCatalogCatalogEntryView[]
      drift: readonly PluginCatalogCatalogDriftView[]
    }>((resolve) => {
      release = () => resolve({ entries: CATALOG, drift: [] })
    })
    const trpc = {
      addons: {
        custom: {
          mutate: async (input: { action: string }) => {
            if (input.action === 'listAvailability') return {}
            if (input.action === 'listPluginCatalogCatalog') return pending
            if (input.action === 'listCustomModels') return []
            throw new Error(input.action)
          },
        },
      },
    } as unknown as AddonPageProps['trpc']
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={trpc} />
      </OperationModalProvider>,
    )
    expect(await screen.findByText(/Loading plugin catalog catalog/i)).toBeTruthy()
    release?.()
    await waitFor(() => expect(screen.queryByText(/Loading plugin catalog catalog/i)).toBeNull())
  })

  it('shows an empty catalog state when the manifesto projection is empty', async () => {
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(makeHarness({ catalog: [], drift: [] }))} />
      </OperationModalProvider>,
    )
    expect(await screen.findByText(/No plugin catalog artifacts for this variant/i)).toBeTruthy()
  })

  it('shows a listing error with retry', async () => {
    const harness = makeHarness({ listError: new Error('catalog unavailable') })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    expect(await screen.findByText(/catalog unavailable/i)).toBeTruthy()
    harness.listError = null
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByTestId('source-family-card')).toBeTruthy()
  })
})

describe('PluginCatalogTab — cards and import', () => {
  it('renders family cards with Import for ok artifacts', async () => {
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(makeHarness())} />
      </OperationModalProvider>,
    )
    const families = await screen.findAllByTestId('source-family-card')
    expect(families.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByRole('button', { name: /^import$/i }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('source-pre-selectors')).toBeTruthy()
    expect(screen.getByRole('option', { name: /Standard/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Test/i })).toBeTruthy()
  })

  it('shows drift status instead of Import when the artifact is missing', async () => {
    const harness = makeHarness({
      catalog: [
        catalogEntry({
          id: 'scrypted-yolov9s-relu-onnx',
          label: 'plugin catalog YOLOv9S ReLU ONNX',
          format: 'onnx',
          precision: 'fp32',
        }),
      ],
      drift: [
        {
          manifestId: 'scrypted-yolov9s-relu-onnx',
          status: 'missing',
          details: 'file missing from tree',
        },
      ],
    })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    await screen.findByTestId('source-family-card')
    expect(screen.getByText(/^missing$/i)).toBeTruthy()
    // Native ONNX blocked; convert slots for OV/CoreML remain (ONNX is the convert source).
    expect(screen.getByText('ONNX').closest('div')?.textContent).toMatch(/missing/i)
  })

  it('replaces Import with imported when the model is in the Library registry', async () => {
    const harness = makeHarness({
      catalog: [
        catalogEntry({
          id: 'scrypted-yolov9s-relu-onnx',
          label: 'plugin catalog YOLOv9S ReLU ONNX',
          format: 'onnx',
          precision: 'fp32',
        }),
      ],
      drift: [{ manifestId: 'scrypted-yolov9s-relu-onnx', status: 'ok' }],
      registered: [
        {
          stepId: 'object-detection',
          entry: modelEntry('scrypted-yolov9s-relu-320', 'onnx', 8.5),
        },
      ],
    })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    await screen.findByTestId('source-family-card')
    // ONNX imported; OV/CoreML convert slots still offer Import.
    expect(screen.getAllByText(/^imported$/i).length).toBe(1)
    expect(screen.getAllByRole('button', { name: /^import$/i }).length).toBe(2)
  })

  it('shows Import when availability is orphaned but Library registry is empty', async () => {
    const harness = makeHarness({
      catalog: [
        catalogEntry({
          id: 'scrypted-yolov9s-relu-onnx',
          label: 'plugin catalog YOLOv9S ReLU ONNX',
          format: 'onnx',
          precision: 'fp32',
        }),
      ],
      drift: [{ manifestId: 'scrypted-yolov9s-relu-onnx', status: 'ok' }],
      registered: [],
    })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    await screen.findByTestId('source-family-card')
    expect(screen.getAllByRole('button', { name: /^import$/i }).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/^imported$/i)).toBeNull()
  })

  it('sends exactly { manifestId } and never a URL, path, labels or classMap', async () => {
    const harness = makeHarness()
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    const importBtns = await screen.findAllByRole('button', { name: /^import$/i })
    fireEvent.click(importBtns[0]!)
    await waitFor(() => {
      const imported = harness.calls.filter((c) => c.action === 'importPluginCatalogCatalogModel')
      expect(imported.length).toBeGreaterThanOrEqual(1)
      expect(Object.keys(imported[0]!.input as object)).toEqual(['manifestId'])
      expect((imported[0]!.input as { manifestId: string }).manifestId).toMatch(/^scrypted-/)
    })
    expect(screen.queryByLabelText(/url/i)).toBeNull()
    expect(screen.queryByLabelText(/class\s*map/i)).toBeNull()
  })

  it('rejects a synchronous double click so only one import starts', async () => {
    const harness = makeHarness()
    let release: (() => void) | undefined
    let started = 0
    harness.importImpl = () => {
      started += 1
      return new Promise((resolve) => {
        release = () =>
          resolve({
            stepId: 'object-detection',
            entry: modelEntry('scrypted-yolov9s-relu-onnx', 'onnx', 8.5),
          })
      })
    }
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    const importBtn = (await screen.findAllByRole('button', { name: /^import$/i }))[0]!
    act(() => {
      importBtn.click()
      importBtn.click()
    })
    expect(started).toBe(1)
    release?.()
    await waitFor(() => {
      expect(
        harness.calls.filter((c) => c.action === 'importPluginCatalogCatalogModel'),
      ).toHaveLength(1)
    })
  })

  it('still offers Import when Library registry listing failed (drift ok)', async () => {
    const harness = makeHarness({ registryError: new Error('registry down') })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    await screen.findByTestId('source-family-card')
    expect(screen.getAllByRole('button', { name: /^import$/i }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^blocked$/i)).toBeNull()
  })

  it('Test fp missing OpenVINO offers convert-from-ONNX while CoreML stays native', async () => {
    const harness = makeHarness({
      catalog: [
        catalogEntry({
          id: 'scrypted-yolov9s-relu_test-onnx',
          label: 'Test S ONNX',
          format: 'onnx',
          precision: 'fp32',
          variant: 'relu_test',
        }),
        catalogEntry({
          id: 'scrypted-yolov9s-relu_test-coreml',
          label: 'Test S CoreML',
          format: 'coreml',
          precision: 'fp16',
          variant: 'relu_test',
        }),
      ],
      drift: [
        { manifestId: 'scrypted-yolov9s-relu_test-onnx', status: 'ok' },
        { manifestId: 'scrypted-yolov9s-relu_test-coreml', status: 'ok' },
      ],
    })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    fireEvent.change(await screen.findByLabelText(/Variant/i), {
      target: { value: 'relu_test' },
    })
    await screen.findByTestId('source-family-card')
    expect(screen.getByText('ONNX')).toBeTruthy()
    expect(screen.getByText('OpenVINO')).toBeTruthy()
    expect(screen.getByText('CoreML')).toBeTruthy()
    // Three Import buttons: onnx native, OV convert, coreml native.
    expect(screen.getAllByRole('button', { name: /^import$/i })).toHaveLength(3)

    const ovImport = screen.getAllByRole('button', { name: /^import$/i })[1]!
    fireEvent.click(ovImport)
    await waitFor(() => {
      expect(harness.calls.some((c) => c.action === 'importPluginCatalogCatalogModel')).toBe(true)
      expect(harness.calls.some((c) => c.action === 'ensureModelFormats')).toBe(true)
    })
    const ensure = harness.calls.find((c) => c.action === 'ensureModelFormats')
    expect(ensure?.input).toEqual({
      modelId: 'scrypted-yolov9s-relu_test-320',
      formats: ['openvino'],
    })
  })

  it('shows TFLite as a fourth format on the same chip (no Coral runtime lane)', async () => {
    const harness = makeHarness({
      catalog: [
        catalogEntry({
          id: 'scrypted-yolov9s-relu-onnx',
          label: 'S ONNX',
          format: 'onnx',
          precision: 'fp32',
        }),
        catalogEntry({
          id: 'scrypted-yolov9s-relu-tflite',
          label: 'S TFLite',
          format: 'tflite',
          precision: 'float16',
        }),
      ],
      drift: [
        { manifestId: 'scrypted-yolov9s-relu-onnx', status: 'ok' },
        { manifestId: 'scrypted-yolov9s-relu-tflite', status: 'ok' },
      ],
    })
    render(
      <OperationModalProvider>
        <PluginCatalogTab trpc={fakeTrpc(harness)} />
      </OperationModalProvider>,
    )
    await screen.findByTestId('source-family-card')
    expect(screen.queryByLabelText(/Runtime/i)).toBeNull()
    expect(screen.getByText('ONNX')).toBeTruthy()
    expect(screen.getByText('TFLite')).toBeTruthy()
    expect(screen.getByText('OpenVINO')).toBeTruthy()
    expect(screen.getByText('CoreML')).toBeTruthy()
  })
})
