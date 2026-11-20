/**
 * A camera block is edited on its block (planning#580): a grid lays out its
 * cells on the camera its block made, and a Terminal camera changes Terminal.
 * Neither opens the helper wizard.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const h = vi.hoisted(() => ({
  view: null as unknown,
  update: vi.fn(async (_input: unknown) => ({})),
  refetch: vi.fn(async () => ({})),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@camstack/ui-library')
  return {
    ...actual,
    CameraGridLayoutEditor: ({ deviceId }: { readonly deviceId: number }) => (
      <div data-testid="grid-layout-editor" data-device-id={deviceId} />
    ),
    SourceCropCanvas: ({
      deviceId,
      rect,
      onDrag,
    }: {
      readonly deviceId: number
      readonly rect: {
        readonly x: number
        readonly y: number
        readonly width: number
        readonly height: number
      }
      readonly onDrag: (drag: unknown) => void
    }) => (
      <button
        type="button"
        data-testid="crop-canvas"
        data-device-id={deviceId}
        onClick={() =>
          onDrag({
            mode: 'move',
            origin: rect,
            dx: 0.1,
            dy: 0,
            point: { x: 0, y: 0 },
            sourceAspect: 16 / 9,
          })
        }
      />
    ),
    useCoreBlocksGetComposition: () => ({
      status: 'success',
      data: { state: 'loaded', view: h.view },
      refetch: h.refetch,
    }),
    useCoreBlocksUpdateComposition: () => ({
      mutateAsync: h.update,
      isPending: false,
    }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn() }),
  }
})

vi.mock('../TerminalCameraPicker', () => ({
  TerminalCameraPicker: ({
    ownBlockId,
    onChange,
  }: {
    readonly ownBlockId: string | null
    readonly onChange: (terminalId: string) => void
  }) => (
    <button
      type="button"
      data-testid="terminal-camera-picker"
      data-own={ownBlockId ?? ''}
      onClick={() => onChange('9a0b1c2d-3e4f-4a6b-8c7d-6b7d3f1c2a4e')}
    >
      pick
    </button>
  ),
}))

vi.mock('../../device/customize/assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      {
        id: 77,
        name: 'Yard',
        addonId: 'reolink',
        stableId: 'cam-yard',
        type: 'camera',
        location: null,
        isCamera: true,
        integration: null,
      },
    ],
  }),
}))

vi.mock('../HelperWizard', () => ({
  HelperWizard: () => <div data-testid="helper-wizard" />,
}))

import { CompositionBlockEditor } from '../CompositionBlockEditor'

function cameraView(helper: unknown, deviceId: number | null): unknown {
  return {
    block: {
      id: 'b1',
      name: 'Hub monitor',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt: 77,
      createdBy: 'test',
      status: 'running',
      lastChangedAt: 1,
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'new', type: 'camera' },
          features: [],
          helper,
        },
      },
    },
    state: {
      kind: 'answered',
      state: deviceId === null ? null : { blockId: 'b1', deviceId, status: 'running', fields: [] },
    },
  }
}

const GRID = {
  kind: 'grid',
  fps: 10,
  publishedProfiles: ['mid', 'low'],
  cells: [],
}

function renderEditor(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CompositionBlockEditor blockId="b1" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('a camera block on its editor', () => {
  beforeEach(() => {
    h.update.mockClear()
  })

  it('a grid lays out its cells on the camera its block made', () => {
    h.view = cameraView(GRID, 4600)
    renderEditor()
    expect(screen.getByTestId('grid-layout-editor').getAttribute('data-device-id')).toBe('4600')
    expect(screen.queryByTestId('helper-wizard')).toBeNull()
  })

  it('a grid whose camera is not there yet says so, with no editor', () => {
    h.view = cameraView(GRID, null)
    renderEditor()
    expect(screen.queryByTestId('grid-layout-editor')).toBeNull()
    expect(screen.getByTestId('grid-camera-pending')).toBeTruthy()
  })

  it('a Terminal camera changes Terminal through the block, keeping its own pickable', async () => {
    h.view = cameraView(
      { kind: 'terminal', terminalId: '3f1c2a4e-6b7d-4e8f-9a0b-1c2d3e4f5a6b' },
      4601,
    )
    renderEditor()
    const picker = screen.getByTestId('terminal-camera-picker')
    expect(picker.getAttribute('data-own')).toBe('b1')
    fireEvent.click(picker)
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({
      blockId: 'b1',
      expectedUpdatedAt: 77,
      block: {
        composition: {
          helper: {
            kind: 'terminal',
            terminalId: '9a0b1c2d-3e4f-4a6b-8c7d-6b7d3f1c2a4e',
          },
        },
      },
    })
  })

  const CROP = {
    kind: 'crop',
    source: { addonId: 'reolink', stableId: 'cam-yard' },
    rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.28125 },
    aspect: '16:9',
    fps: 10,
    publishedProfiles: ['mid', 'low'],
  }

  it('a crop camera opens the crop editor on its source, never the Terminal picker', () => {
    h.view = cameraView(CROP, 4602)
    renderEditor()
    expect(screen.getByTestId('crop-block-editor')).toBeTruthy()
    expect(screen.getByTestId('crop-canvas').getAttribute('data-device-id')).toBe('77')
    expect(screen.queryByTestId('terminal-camera-picker')).toBeNull()
    expect(screen.queryByTestId('terminal-camera-editor')).toBeNull()
    expect(h.update).not.toHaveBeenCalled()
  })

  it('a moved crop is written once, on Save, as a crop block', async () => {
    h.view = cameraView(CROP, 4602)
    renderEditor()
    const save = screen.getByTestId('crop-save')
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('crop-canvas'))
    fireEvent.click(save)
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
    const written = h.update.mock.calls[0]?.[0] as {
      block: { composition: { helper: { kind: string; rect: { x: number } } } }
    }
    expect(written.block.composition.helper.kind).toBe('crop')
    expect(written.block.composition.helper.rect.x).toBeCloseTo(0.3)
  })
})
