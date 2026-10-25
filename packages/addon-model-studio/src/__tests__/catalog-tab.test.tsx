// @vitest-environment jsdom
/**
 * Catalog lists CamStack seeds (source=camstack) and acquisition UIs for
 * plugin catalog / plus catalog. Custom lives under Import; Installed is inventory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import { CatalogTab, type CatalogSource } from '../tabs/CatalogTab.js'
import { OperationModalProvider } from '../components/OperationModalProvider.js'

vi.mock('../components/NodeSelector.js', () => ({
  NodeSelector: ({ selectedNodeId }: { selectedNodeId: string }) => (
    <div data-testid="node-selector">{selectedNodeId}</div>
  ),
}))

afterEach(cleanup)

interface CatalogPipelineExecutorStub {
  readonly getSchema: { query: (input?: { nodeId?: string }) => Promise<unknown> }
  readonly downloadModel: { mutate: (input: unknown) => Promise<unknown> }
}

/** Minimal tRPC stub carrying the members the Catalog tab calls (`requireTrpcMember`). */
function catalogTrpc(pipelineExecutor: CatalogPipelineExecutorStub): AddonPageProps['trpc'] {
  return {
    addons: { custom: { mutate: async () => ({}) } },
    pipelineExecutor,
  } as unknown as AddonPageProps['trpc']
}

function renderCatalog(trpc: AddonPageProps['trpc'], source: CatalogSource = 'camstack') {
  return render(
    <OperationModalProvider>
      <CatalogTab trpc={trpc} refreshKey={0} source={source} onSourceChange={() => {}} />
    </OperationModalProvider>,
  )
}

describe('CatalogTab', () => {
  it('groups size variants into one family card and downloads the selected model', async () => {
    const downloads: unknown[] = []
    const trpc = catalogTrpc({
      getSchema: {
        query: async (input?: { nodeId?: string }) => {
          expect(input?.nodeId).toBe('hub')
          return {
            slots: [
              {
                addons: [
                  {
                    id: 'object-detection',
                    name: 'Object detection',
                    models: [
                      {
                        id: 'yolo26n',
                        name: 'YOLO26 Nano',
                        provider: 'camstack',
                        group: { family: 'yolo26', tier: 'n', resolution: 640 },
                        formats: { onnx: { downloaded: false, sizeMB: 6 } },
                      },
                      {
                        id: 'yolo26s',
                        name: 'YOLO26 Small',
                        provider: 'camstack',
                        group: { family: 'yolo26', tier: 's', resolution: 640 },
                        formats: { onnx: { downloaded: false, sizeMB: 20 } },
                      },
                      {
                        id: 'yolo26n-int8',
                        name: 'YOLO26 Nano Int8',
                        provider: 'camstack',
                        group: {
                          family: 'yolo26',
                          tier: 'n',
                          precision: 'int8',
                          resolution: 640,
                        },
                        formats: { onnx: { downloaded: false, sizeMB: 4 } },
                      },
                    ],
                  },
                ],
              },
            ],
          }
        },
      },
      downloadModel: {
        mutate: async (input: unknown) => {
          downloads.push(input)
        },
      },
    })

    renderCatalog(trpc)
    expect(await screen.findByTestId('catalog-family')).toBeTruthy()
    expect(screen.getAllByTestId('catalog-family')).toHaveLength(1)
    expect(screen.queryAllByTestId('catalog-seed')).toHaveLength(0)
    expect(screen.getByText('YOLO26')).toBeTruthy()
    expect(screen.getByText('Nano')).toBeTruthy()
    expect(screen.getByText('Small')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toEqual({
      addonId: 'object-detection',
      modelId: 'yolo26n',
      format: 'onnx',
      nodeId: 'hub',
    })
  })

  it('lists an ungrouped CamStack seed as a flat card and downloads it', async () => {
    const downloads: unknown[] = []
    const trpc = catalogTrpc({
      getSchema: {
        query: async () => ({
          slots: [
            {
              addons: [
                {
                  id: 'object-detection',
                  name: 'Object detection',
                  models: [
                    {
                      id: 'ssd-mobilenet-v2-coco-edgetpu',
                      name: 'SSD MobileNet V2 (EdgeTPU)',
                      provider: 'camstack',
                      formats: { tflite: { downloaded: false, sizeMB: 7 } },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
      downloadModel: {
        mutate: async (input: unknown) => {
          downloads.push(input)
        },
      },
    })

    renderCatalog(trpc)
    expect(await screen.findByTestId('catalog-seed')).toBeTruthy()
    expect(screen.queryByTestId('catalog-family')).toBeNull()
    expect(screen.getByText('SSD MobileNet V2 (EdgeTPU)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toEqual({
      addonId: 'object-detection',
      modelId: 'ssd-mobilenet-v2-coco-edgetpu',
      format: 'tflite',
      nodeId: 'hub',
    })
  })

  it('CamStack source hides plugin catalog/plus catalog pipeline seeds (those live under their Catalog source)', async () => {
    const trpc = catalogTrpc({
      getSchema: {
        query: async () => ({
          slots: [
            {
              addons: [
                {
                  id: 'object-detection',
                  name: 'Object detection',
                  models: [
                    {
                      id: 'yolov9c-640',
                      name: 'YOLOv9 Compact @640',
                      provider: 'camstack',
                      group: { family: 'yolov9', tier: 'c', resolution: 640 },
                      formats: { onnx: { downloaded: false, sizeMB: 50 } },
                    },
                    {
                      id: 'scrypted-yolov9t-relu-onnx',
                      name: 'plugin catalog YOLOv9T ReLU ONNX',
                      provider: 'scrypted',
                      group: { family: 'yolov9', tier: 't', resolution: 320 },
                      formats: { onnx: { downloaded: true, sizeMB: 8 } },
                    },
                    {
                      id: 'frigate-mobiledet-edgetpu',
                      name: 'plus catalog default — SSDLite MobileDet',
                      provider: 'frigate',
                      group: { family: 'ssdlite-mobiledet', tier: 'default', resolution: 320 },
                      formats: { tflite: { downloaded: true, sizeMB: 5 } },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
      downloadModel: { mutate: async () => undefined },
    })

    renderCatalog(trpc, 'camstack')
    expect(await screen.findByTestId('catalog-tab')).toBeTruthy()
    expect(screen.getByTestId('catalog-provider').getAttribute('data-provider')).toBe('camstack')
    const families = screen
      .getAllByTestId('catalog-family')
      .map((el) => el.getAttribute('data-family'))
    expect(families).toEqual(['yolov9'])
    expect(screen.queryByText('plugin catalog YOLOv9T ReLU ONNX')).toBeNull()
    expect(screen.queryByText(/SSDLite MobileDet/)).toBeNull()
  })

  it('plugin catalog source shows plugin catalog acquisition catalog (not Installed inventory)', async () => {
    const trpc = {
      pipelineExecutor: {
        getSchema: { query: async () => ({ slots: [] }) },
      },
      addons: {
        custom: {
          mutate: async (input: { action: string }) => {
            if (input.action === 'listPluginCatalogCatalog') return { entries: [], drift: [] }
            if (input.action === 'listCustomModels') return []
            if (input.action === 'listAvailability') return {}
            if (input.action === 'tfliteSupport') return { nodes: ['hub'] }
            throw new Error(`unexpected ${input.action}`)
          },
        },
      },
    } as unknown as AddonPageProps['trpc']

    renderCatalog(trpc, 'scrypted')
    expect(await screen.findByTestId('plugin-catalog-tab')).toBeTruthy()
    expect(screen.queryByTestId('catalog-inventory')).toBeNull()
  })

  it('plus catalog source shows plus catalog section', async () => {
    const trpc = {
      pipelineExecutor: {
        getSchema: { query: async () => ({ slots: [] }) },
      },
      addons: {
        custom: {
          mutate: async (input: { action: string }) => {
            if (input.action === 'plusCatalogPlusStatus') {
              return { configured: false, keyFormatValid: false }
            }
            if (input.action === 'tfliteSupport') return { nodes: ['hub'] }
            throw new Error(`unexpected ${input.action}`)
          },
        },
      },
    } as unknown as AddonPageProps['trpc']

    renderCatalog(trpc, 'frigate')
    // No key configured → the plus catalog section's inline key panel.
    expect(await screen.findByText(/Required to list your account models/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /save key/i })).toBeTruthy()
  })
})
