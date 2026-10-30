// @vitest-environment jsdom
/**
 * Installed — one row per model × format on the selected node; device chips
 * from the node's devices + resident pools; Remove per format; filters
 * (provider · step · device · node) in the URL; a Cluster models section with
 * per-node placement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmDialogProvider, type AddonPageProps } from '@camstack/ui-library'
import { InstalledTab } from '../tabs/InstalledTab.js'
import type { ReactElement } from 'react'

vi.mock('../components/NodeSelector.js', () => ({
  NodeSelector: ({
    selectedNodeId,
    onSelect,
  }: {
    selectedNodeId: string
    onSelect: (id: string) => void
  }) => (
    <button type="button" data-testid="node-selector" onClick={() => onSelect('agent-a')}>
      {selectedNodeId}
    </button>
  ),
}))

vi.mock('../components/installed/use-online-node-ids.js', () => ({
  useOnlineNodeIds: () => ['hub', 'agent-a'],
}))

vi.mock('../components/InstalledSettingsModal.js', () => ({
  InstalledSettingsModal: ({ modelId, deviceKey }: { modelId: string; deviceKey: string }) => (
    <div data-testid="installed-settings-modal" data-model={modelId} data-device={deviceKey} />
  ),
}))

afterEach(cleanup)

beforeEach(() => {
  window.history.replaceState(null, '', '/model-studio?tab=installed')
})

function renderInstalled(ui: ReactElement) {
  return render(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>)
}

interface Calls {
  readonly deletes: unknown[]
  readonly nodeRemoves: unknown[]
  readonly setDevices: unknown[]
  readonly renames: unknown[]
}

/** The live hub shape: CPU disabled (yolo26n default), GPU+NPU on yolov9m-320-int8. */
function hubTrpc(opts?: {
  readonly pinYoloOnGpu?: boolean
  readonly allDevicesOff?: boolean
  readonly devicesFail?: boolean
}): {
  trpc: AddonPageProps['trpc']
  calls: Calls
} {
  const calls: Calls = { deletes: [], nodeRemoves: [], setDevices: [], renames: [] }
  let customName = 'My Custom'
  const devicesOf = (nodeId: string) =>
    nodeId === 'agent-a'
      ? [
          {
            key: 'edgetpu:usb',
            backend: 'edgetpu',
            device: 'usb',
            format: 'tflite' as const,
            available: true,
            enabled: true,
            weight: 1,
            maxSessions: 1,
            defaultModelId: 'ssd',
            exclusion: null,
          },
        ]
      : [
          {
            key: 'cpu',
            backend: 'cpu',
            device: 'cpu',
            format: 'onnx' as const,
            available: true,
            enabled: false,
            weight: 1,
            maxSessions: null,
            defaultModelId: 'yolo26n',
            exclusion: 'disabled' as const,
          },
          ...['gpu', 'npu'].map((d) => ({
            key: `openvino:${d}`,
            backend: 'openvino',
            device: d,
            format: 'openvino' as const,
            available: true,
            enabled: true,
            weight: 50,
            maxSessions: null,
            defaultModelId: 'yolov9m-320-int8',
            exclusion: null,
            steps:
              opts?.pinYoloOnGpu === true && d === 'gpu'
                ? { 'object-detection': { modelId: 'yolo26n' } }
                : {},
          })),
        ]
  const enginesOf = (nodeId: string) =>
    nodeId === 'agent-a'
      ? []
      : [
          {
            engineKey: 'python/openvino/npu',
            engine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'npu' },
            modelsLoaded: ['object-detection/yolov9m-320-int8', 'face-embedding/auraface-r100'],
            inUseByCameras: [],
            kind: 'runtime',
            poolPid: 1,
            idleMs: null,
            idleTtlMs: null,
          },
          {
            engineKey: 'python/openvino/gpu [openvino:gpu]',
            engine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'gpu' },
            modelsLoaded: ['object-detection/yolov9m-320-int8', 'face-embedding/auraface-r100'],
            inUseByCameras: [],
            kind: 'device-pool',
            poolPid: 2,
            idleMs: null,
            idleTtlMs: null,
          },
        ]
  const fmt = (onDisk: 'current' | 'stale' | 'missing', sizeMB: number, precision?: string) => ({
    downloaded: onDisk === 'current',
    onDisk,
    sizeMB,
    ...(precision ? { precision } : {}),
  })
  const schemaOf = (nodeId: string) => ({
    slots: [
      {
        addons: [
          {
            id: 'object-detection',
            name: 'Object detection',
            slot: 'detector',
            defaultModelId: 'yolo26n',
            models: [
              {
                id: 'yolo26n',
                name: 'YOLO26 Nano',
                provider: 'camstack',
                formats:
                  nodeId === 'agent-a'
                    ? { onnx: fmt('missing', 10) }
                    : { onnx: fmt('current', 10), openvino: fmt('current', 9) },
              },
              {
                id: 'yolov9m-320-int8',
                name: 'YOLOv9m 320 INT8',
                provider: 'camstack',
                formats: {
                  openvino: fmt(nodeId === 'agent-a' ? 'missing' : 'current', 20, 'int8'),
                },
              },
              {
                id: 'my-custom',
                name: customName,
                provider: 'custom',
                formats: { onnx: fmt('current', 3) },
              },
            ],
          },
          {
            id: 'face-embedding',
            name: 'Face embedding',
            slot: 'classifier',
            defaultModelId: 'auraface-r100',
            models: [
              {
                id: 'auraface-r100',
                name: 'AuraFace R100',
                provider: 'camstack',
                formats: { onnx: fmt('current', 261), openvino: fmt('current', 131) },
              },
            ],
          },
        ],
      },
    ],
  })
  const surface = {
    pipelineExecutor: {
      getSchema: { query: async (input?: { nodeId?: string }) => schemaOf(input?.nodeId ?? 'hub') },
      listLoadedEngines: {
        query: async (input: { nodeId: string }) => enginesOf(input.nodeId),
      },
    },
    pipelineOrchestrator: {
      getNodeInferenceDevices: {
        query: async (input: { nodeId: string }) => {
          if (opts?.devicesFail === true) throw new Error('probe unreachable')
          const devices = devicesOf(input.nodeId)
          return {
            devices:
              opts?.allDevicesOff === true
                ? devices.map((d) => ({ ...d, enabled: false }))
                : devices,
          }
        },
      },
      setAgentInferenceDevices: {
        mutate: async (input: unknown) => {
          calls.setDevices.push(input)
        },
      },
    },
    addonSettings: {
      getGlobalSettings: { query: async () => ({ sections: [] }) },
      updateGlobalSettings: { mutate: async () => ({}) },
    },
    addons: {
      custom: {
        mutate: async (input: { action: string; input?: unknown }) => {
          switch (input.action) {
            case 'listCustomModels':
              return [
                {
                  stepId: 'object-detection',
                  entry: {
                    id: 'my-custom',
                    name: customName,
                    description: 'Operator upload',
                    provider: 'custom',
                    formats: {
                      onnx: {
                        url: 'camstack-local://my-custom/a.onnx',
                        sizeMB: 3,
                        runtimes: ['python'],
                      },
                    },
                    inputSize: { width: 320, height: 320 },
                    labels: [{ id: 'person', name: 'person' }],
                  },
                },
              ]
            case 'listAvailability':
              return {}
            case 'renameCustomModel':
              calls.renames.push(input.input)
              customName = 'Porch detector'
              return { modelId: 'my-custom', name: customName }
            case 'deleteSeedFromNode':
              calls.deletes.push(input.input)
              return { success: true }
            case 'removeModelFromNode':
              calls.nodeRemoves.push(input.input)
              return { deleted: true, clearedAvailability: true }
            default:
              throw new Error(`unexpected ${input.action}`)
          }
        },
      },
    },
  }
  return { trpc: surface as unknown as AddonPageProps['trpc'], calls }
}

/** The table row (or phone card) of one model × format. */
async function fileRow(modelId: string, format: string): Promise<HTMLElement> {
  const marker = await screen.findByTestId(
    (_id, el) => el?.getAttribute('data-row-key')?.endsWith(`::${modelId}::${format}`) === true,
  )
  const row = marker.closest('tr') ?? marker.closest('[data-data-table-card]')
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${modelId} ${format}`)
  return row
}

function rowMarker(row: HTMLElement): HTMLElement {
  const m = row.querySelector('[data-testid="installed-file"]')
  if (!(m instanceof HTMLElement)) throw new Error('row has no marker')
  return m
}

describe('InstalledTab', () => {
  it('lists one row per model × format, each with its own size', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    const onnx = await fileRow('yolo26n', 'onnx')
    const ov = await fileRow('yolo26n', 'openvino')
    expect(within(onnx).getByText('10.0 MB')).toBeTruthy()
    expect(within(ov).getByText('9.0 MB')).toBeTruthy()
    expect(within(await fileRow('yolov9m-320-int8', 'openvino')).getByText('int8')).toBeTruthy()
  })

  it('a disabled CPU is "off" and its format default is unused, with Remove (live hub)', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    const onnx = await fileRow('yolo26n', 'onnx')
    expect(rowMarker(onnx).getAttribute('data-usage')).toBe('unused')
    const cpu = within(onnx).getByLabelText('CPU (cpu): off')
    expect(cpu.getAttribute('data-state')).toBe('off')
    expect(cpu.textContent?.trim()).toBe('CPU')
    expect(within(onnx).getByRole('button', { name: 'Remove yolo26n onnx' })).toBeTruthy()
    expect(screen.getByTestId('installed-remove-unused-bulk')).toBeTruthy()
  })

  it('a node whose every inference device is disabled says so explicitly', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc({ allDevicesOff: true }).trpc} refreshKey={0} />)
    const notice = await screen.findByTestId('installed-devices-notice')
    expect(notice.getAttribute('data-kind')).toBe('all-disabled')
    expect(notice.textContent).toContain('All inference devices are disabled on this node')
  })

  it('an unanswered device read is "unknown", never "all disabled" (D315)', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc({ devicesFail: true }).trpc} refreshKey={0} />)
    const notice = await screen.findByTestId('installed-devices-notice')
    expect(notice.getAttribute('data-kind')).toBe('unknown')
    expect(notice.textContent).not.toContain('disabled')
  })

  it('a node with an enabled device shows no devices notice', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    await fileRow('yolo26n', 'onnx')
    expect(screen.queryByTestId('installed-devices-notice')).toBeNull()
  })

  it('Remove unused bulk deletes every reclaimable file on the filtered view, after one confirm', async () => {
    const { trpc, calls } = hubTrpc()
    renderInstalled(<InstalledTab trpc={trpc} refreshKey={0} />)
    await fileRow('yolo26n', 'onnx')
    fireEvent.click(screen.getByTestId('installed-remove-unused-bulk'))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(/No enabled device on this node runs these formats/),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete unused files' }))
    await waitFor(() => {
      // idle + unused (same set as per-row Remove), not unused-only
      expect(calls.deletes.length).toBeGreaterThanOrEqual(2)
      expect(calls.deletes).toEqual(
        expect.arrayContaining([
          { addonId: 'object-detection', modelId: 'yolo26n', format: 'onnx', nodeId: 'hub' },
          { addonId: 'face-embedding', modelId: 'auraface-r100', format: 'onnx', nodeId: 'hub' },
        ]),
      )
    })
  })

  it('NPU and iGPU running one IR are two loaded chips on one row, with no Remove', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    const row = await fileRow('yolov9m-320-int8', 'openvino')
    expect(rowMarker(row).getAttribute('data-usage')).toBe('in-use')
    const chips = within(row).getByTestId('installed-device-chips')
    expect(
      [...chips.querySelectorAll('[data-device-key]')].map((c) => c.getAttribute('data-state')),
    ).toEqual(['loaded, configured', 'loaded, configured'])
    expect(within(row).queryByRole('button', { name: /^Remove/ })).toBeNull()
  })

  it('Remove deletes ONE format on this node, after a confirm', async () => {
    const { trpc, calls } = hubTrpc()
    renderInstalled(<InstalledTab trpc={trpc} refreshKey={0} />)
    const onnx = await fileRow('yolo26n', 'onnx')
    fireEvent.click(within(onnx).getByRole('button', { name: 'Remove yolo26n onnx' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Its other formats stay/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }))
    await waitFor(() => {
      expect(calls.deletes).toEqual([
        { addonId: 'object-detection', modelId: 'yolo26n', format: 'onnx', nodeId: 'hub' },
      ])
    })
  })

  it('an imported model is removed per format through the registry, and renamed in place', async () => {
    const { trpc, calls } = hubTrpc()
    renderInstalled(<InstalledTab trpc={trpc} refreshKey={0} />)
    const custom = await fileRow('my-custom', 'onnx')
    expect(
      within(await fileRow('yolo26n', 'onnx')).queryByRole('button', { name: /^Rename/ }),
    ).toBeNull()
    fireEvent.click(within(custom).getByRole('button', { name: 'Remove my-custom onnx' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete file' }),
    )
    await waitFor(() => {
      expect(calls.nodeRemoves).toEqual([{ modelId: 'my-custom', format: 'onnx', nodeId: 'hub' }])
    })
    expect(calls.deletes).toEqual([])

    fireEvent.click(
      within(await fileRow('my-custom', 'onnx')).getByRole('button', { name: 'Rename My Custom' }),
    )
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Porch detector' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => {
      expect(calls.renames).toEqual([{ modelId: 'my-custom', name: 'Porch detector' }])
    })
  })

  it('an idle enabled chip confirms, then pins the model on that device', async () => {
    const { trpc, calls } = hubTrpc()
    renderInstalled(<InstalledTab trpc={trpc} refreshKey={0} />)
    const ov = await fileRow('yolo26n', 'openvino')
    expect(rowMarker(ov).getAttribute('data-usage')).toBe('idle')
    fireEvent.click(within(ov).getByRole('button', { name: /^iGPU \(openvino:gpu\)/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Pin "YOLO26 Nano"/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(calls.setDevices.length).toBe(1))
    const payload = calls.setDevices[0] as {
      agentNodeId: string
      inferenceDevices: Record<string, { steps?: Record<string, { modelId?: string }> }>
    }
    expect(payload.agentNodeId).toBe('hub')
    expect(payload.inferenceDevices['openvino:gpu']?.steps?.['object-detection']?.modelId).toBe(
      'yolo26n',
    )
  })

  it("a configured chip opens that device's settings", async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc({ pinYoloOnGpu: true }).trpc} refreshKey={0} />)
    const ov = await fileRow('yolo26n', 'openvino')
    expect(rowMarker(ov).getAttribute('data-usage')).toBe('configured')
    fireEvent.click(within(ov).getByRole('button', { name: /^iGPU \(openvino:gpu\)/ }))
    const modal = await screen.findByTestId('installed-settings-modal')
    expect(modal.getAttribute('data-model')).toBe('yolo26n')
    expect(modal.getAttribute('data-device')).toBe('openvino:gpu')
  })

  it('a cluster model has read-only chips — nothing rewrites the cluster row from a row', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    const face = await fileRow('auraface-r100', 'openvino')
    expect(
      within(face)
        .queryAllByRole('button')
        .filter((b) => b.hasAttribute('data-device-key')),
    ).toEqual([])
  })

  it('the Cluster models section says per node where the model runs, or that the node refuses it', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    const cards = await screen.findAllByTestId('cluster-model-card')
    const face = cards.find((c) => c.getAttribute('data-step') === 'face-embedding')
    if (face === undefined) throw new Error('no face card')
    await waitFor(() => expect(within(face).getByText('iGPU, NPU')).toBeTruthy())
    expect(within(face).getByText('loaded')).toBeTruthy()
    expect(within(face).getByText('no build for tflite → refused')).toBeTruthy()
  })

  it('filters by device: the rows whose format that device runs', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    await fileRow('yolo26n', 'onnx')
    fireEvent.change(screen.getByTestId('installed-device-filter'), {
      target: { value: 'openvino:npu' },
    })
    expect(window.location.search).toMatch(/device=openvino%3Anpu|device=openvino:npu/)
    await waitFor(() =>
      expect(
        screen.getAllByTestId('installed-file').map((m) => m.getAttribute('data-row-key')),
      ).toEqual([
        'face-embedding::auraface-r100::openvino',
        'object-detection::yolo26n::openvino',
        'object-detection::yolov9m-320-int8::openvino',
      ]),
    )
    const option = screen.getByRole('option', { name: 'CPU · cpu (off)' })
    expect(option).toBeTruthy()
  })

  it('writes provider/type/node to the URL and keeps filters when the node changes', async () => {
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    await screen.findByTestId('installed-filters')
    const providerGroup = screen.getByTestId('installed-provider-filter')
    fireEvent.click(within(providerGroup).getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByTestId('installed-type-filter'), {
      target: { value: 'object-detection' },
    })
    expect(window.location.search).toMatch(/provider=custom/)
    expect(window.location.search).toMatch(/type=object-detection/)

    fireEvent.click(screen.getByTestId('node-selector'))
    expect((await screen.findByTestId('node-selector')).textContent).toBe('agent-a')
    expect(window.location.search).toMatch(/node=agent-a/)
    expect(window.location.search).toMatch(/provider=custom/)
    expect(
      within(providerGroup).getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect((screen.getByTestId('installed-type-filter') as HTMLSelectElement).value).toBe(
      'object-detection',
    )
  })

  it('honors ?provider=&type=&node= deeplink', async () => {
    window.history.replaceState(
      null,
      '',
      '/model-studio?tab=installed&provider=custom&type=object-detection&node=agent-a',
    )
    renderInstalled(<InstalledTab trpc={hubTrpc().trpc} refreshKey={0} />)
    expect((await screen.findByTestId('node-selector')).textContent).toBe('agent-a')
    const rows = await screen.findAllByTestId('installed-file')
    expect(rows.map((m) => m.getAttribute('data-row-key'))).toEqual([
      'object-detection::my-custom::onnx',
    ])
  })
})
