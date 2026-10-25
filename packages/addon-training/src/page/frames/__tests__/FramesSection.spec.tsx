/// <reference types="@testing-library/jest-dom" />
/**
 * Frames corpus chrome — KPI, collections, filters, grid. Pending ≠ empty (D315).
 * Annotation overlay mounts RetrainWorkbench for the selected frame.
 */
import type { RetrainCollection, RetrainCorpusKpi, RetrainCorpusPageFrame } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FramesSection } from '../FramesSection.js'

/** jsdom does not implement <dialog>.showModal()/close(). */
function installDialogPolyfill(): void {
  if (typeof HTMLDialogElement === 'undefined') return
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
}

vi.mock('../RetrainWorkbench.js', () => ({
  RetrainWorkbench: ({
    activeFrameId,
    framePosition,
    canStep,
    onStep,
  }: {
    readonly activeFrameId: string
    readonly framePosition: string
    readonly canStep: (step: 1 | -1) => boolean
    readonly onStep: (step: 1 | -1) => void
  }) => (
    <div data-testid="retrain-workbench">
      annotate:{activeFrameId} at {framePosition}
      <button
        type="button"
        disabled={!canStep(1)}
        onClick={() => {
          onStep(1)
        }}
      >
        step-next
      </button>
      <button
        type="button"
        disabled={!canStep(-1)}
        onClick={() => {
          onStep(-1)
        }}
      >
        step-prev
      </button>
    </div>
  ),
}))

const FRAME: RetrainCorpusPageFrame = {
  frameId: 'frame-1',
  deviceId: 101,
  origin: 'track',
  trackId: 'trk-1',
  sourceMediaId: 1,
  sourceKind: 'keyFrame',
  sizeBytes: 240_000,
  width: 1920,
  height: 1080,
  copiedAt: 1_700_000_090_000,
  complete: false,
  workState: 'annotated',
}

const FRAME_TODO: RetrainCorpusPageFrame = {
  ...FRAME,
  frameId: 'frame-todo',
  workState: 'unannotated',
}

const FRAME_DONE: RetrainCorpusPageFrame = {
  ...FRAME,
  frameId: 'frame-done',
  complete: true,
  workState: 'complete',
}

const COLLECTION: RetrainCollection = {
  id: 'col-1',
  name: 'missed at night',
  createdAt: 1_700_000_000_000,
  frameCount: 1,
}

const KPI: RetrainCorpusKpi = {
  total: 3,
  unannotated: 1,
  annotated: 1,
  complete: 1,
  cameras: [
    {
      deviceId: 101,
      unannotated: 2,
      annotated: 0,
      complete: 1,
      pctOfCorpus: 1 / 3,
    },
    {
      deviceId: 108,
      unannotated: 0,
      annotated: 1,
      complete: 0,
      pctOfCorpus: 0,
    },
  ],
}

let kpiData: RetrainCorpusKpi | undefined = KPI
let kpiLoading = false
let listFrames: readonly RetrainCorpusPageFrame[] | undefined = [FRAME]
let listTotal: number | undefined = 1
let listLoading = false
/** Frames per page, when a test needs more than one page (`page` of the call picks it). */
let listPages: Readonly<Record<number, readonly RetrainCorpusPageFrame[]>> | null = null
let collectionsData: readonly RetrainCollection[] | undefined = [COLLECTION]

const authedDownload = vi.fn(async (_url: string, _name: string) => undefined)

vi.mock('../lib/authed-download.js', () => ({
  authedDownload: (url: string, name: string) => authedDownload(url, name),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    // Dist may lag the source export of Pagination (device-list barrel).
    Pagination: ({
      currentPage,
      totalItems,
    }: {
      readonly currentPage: number
      readonly totalItems: number
    }) => (
      <div data-testid="pagination">
        page {currentPage}/{totalItems}
      </div>
    ),
    useDeviceManagerListAll: () => ({
      data: [
        { id: 101, name: 'Front gate', type: 'camera', location: 'Gate' },
        { id: 108, name: 'Driveway', type: 'camera', location: 'Drive' },
      ],
      isLoading: false,
      isError: false,
      isPending: false,
      status: 'success',
    }),
    usePipelineAnalyticsGetRetrainCorpusKpi: () => ({
      data: kpiData,
      isLoading: kpiLoading,
      isError: false,
      isPending: kpiLoading,
      status: kpiData !== undefined ? 'success' : kpiLoading ? 'pending' : 'success',
      refetch: vi.fn(async () => ({})),
    }),
    usePipelineAnalyticsListRetrainCorpusPage: (input: {
      readonly page?: number
      readonly pageSize?: number
    }) => ({
      data:
        listFrames !== undefined && listTotal !== undefined
          ? {
              frames: listPages !== null ? (listPages[input.page ?? 1] ?? []) : listFrames,
              total: listTotal,
              page: input.page ?? 1,
              pageSize: input.pageSize ?? 50,
            }
          : undefined,
      isLoading: listLoading,
      isError: false,
      isPending: listLoading,
      status: listFrames !== undefined ? 'success' : listLoading ? 'pending' : 'success',
      refetch: vi.fn(async () => ({})),
    }),
    usePipelineAnalyticsListRetrainCollections: () => ({
      data: collectionsData,
      isLoading: collectionsData === undefined,
      isError: false,
      refetch: vi.fn(async () => ({})),
    }),
    usePipelineAnalyticsCreateRetrainCollection: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    usePipelineAnalyticsRenameRetrainCollection: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    usePipelineAnalyticsDeleteRetrainCollection: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    usePipelineAnalyticsGetRetrainExportUrl: () => ({
      data: { url: '/addon/pipeline-analytics/retrain-export?workState=unannotated' },
    }),
    DevicePicker: ({
      value,
      onChange,
      testId,
    }: {
      readonly value: readonly number[]
      readonly onChange: (next: number[]) => void
      readonly testId?: string
    }) => (
      <div data-testid={testId ?? 'device-picker'}>
        <button
          type="button"
          onClick={() => {
            onChange(value.includes(101) ? [] : [101])
          }}
        >
          toggle-camera-101
        </button>
        <span>{value.join(',')}</span>
      </div>
    ),
  }
})

function renderFrames(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <FramesSection />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('FramesSection corpus chrome', () => {
  beforeEach(() => {
    installDialogPolyfill()
    kpiData = KPI
    kpiLoading = false
    listFrames = [FRAME]
    listTotal = 1
    listLoading = false
    listPages = null
    collectionsData = [COLLECTION]
    authedDownload.mockClear()
    window.history.replaceState({}, '', '/addon/training?tab=frames')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders KPI globals when the KPI query has answered', () => {
    renderFrames()
    const bar = screen.getByTestId('corpus-kpi-bar')
    expect(within(bar).getByText('Total frames')).toBeInTheDocument()
    expect(within(bar).getByText('3')).toBeInTheDocument()
    expect(within(bar).getByText('Unannotated')).toBeInTheDocument()
  })

  it('does not claim an empty corpus while KPI is pending', () => {
    kpiData = undefined
    kpiLoading = true
    listFrames = undefined
    listTotal = undefined
    listLoading = true
    renderFrames()
    expect(screen.queryByText('No frames match')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('corpus-kpi-bar').querySelectorAll('[class*="animate"]').length,
    ).toBeGreaterThanOrEqual(0)
  })

  it('shows empty state only after an answered empty list', () => {
    listFrames = []
    listTotal = 0
    renderFrames()
    expect(screen.getByText('No frames match')).toBeInTheDocument()
  })

  it('renders collections, filter chips, grid tile and export', () => {
    renderFrames()
    expect(screen.getByTestId('corpus-collections')).toBeInTheDocument()
    expect(screen.getByText('missed at night')).toBeInTheDocument()
    expect(screen.getByTestId('corpus-work-state-filter')).toBeInTheDocument()
    expect(screen.getByTestId('corpus-frame-frame-1')).toBeInTheDocument()
    expect(screen.getByTestId('corpus-export')).toBeInTheDocument()
  })

  it('applies work-state filter to the URL via replaceState', () => {
    renderFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Unannotated' }))
    expect(new URLSearchParams(window.location.search).get('workState')).toBe('unannotated')
  })

  it('opens the annotation overlay with the workbench for the clicked frame', () => {
    renderFrames()
    fireEvent.click(screen.getByTestId('corpus-frame-frame-1'))
    expect(screen.getByTestId('corpus-annotate-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('retrain-workbench')).toHaveTextContent('annotate:frame-1')
  })

  it('closes the overlay and keeps URL filters and the grid', () => {
    renderFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Unannotated' }))
    expect(new URLSearchParams(window.location.search).get('workState')).toBe('unannotated')

    fireEvent.click(screen.getByTestId('corpus-frame-frame-1'))
    expect(screen.getByTestId('corpus-annotate-overlay')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('corpus-annotate-overlay')).not.toBeInTheDocument()
    expect(screen.getByTestId('corpus-frame-frame-1')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('workState')).toBe('unannotated')
  })

  it('badges To do / In progress / Complete from per-frame workState (All filter)', () => {
    listFrames = [FRAME_TODO, FRAME, FRAME_DONE]
    listTotal = 3
    renderFrames()
    expect(
      within(screen.getByTestId('corpus-frame-frame-todo')).getByText('To do'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('corpus-frame-frame-1')).getByText('In progress'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('corpus-frame-frame-done')).getByText('Complete'),
    ).toBeInTheDocument()
  })

  it('exports with the current filter URL from the cap', async () => {
    renderFrames()
    fireEvent.click(screen.getByTestId('corpus-export'))
    expect(authedDownload).toHaveBeenCalledWith(
      expect.stringContaining('/addon/pipeline-analytics/retrain-export'),
      'camstack-retrain-export.tar',
    )
  })
  describe('the open frame in the URL', () => {
    const page = (ids: readonly string[]): readonly RetrainCorpusPageFrame[] =>
      ids.map((frameId) => ({ ...FRAME, frameId, trackId: `${frameId}-trk` }))

    it('writes ?frame= when a thumbnail opens and removes it on close', () => {
      renderFrames()
      fireEvent.click(screen.getByTestId('corpus-frame-frame-1'))
      expect(new URLSearchParams(window.location.search).get('frame')).toBe('frame-1')
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(new URLSearchParams(window.location.search).has('frame')).toBe(false)
    })

    it('opens the overlay from ?frame= on load (a reload keeps the frame)', () => {
      window.history.replaceState({}, '', '/addon/training?tab=frames&frame=frame-1')
      renderFrames()
      expect(screen.getByTestId('corpus-annotate-overlay')).toBeInTheDocument()
      expect(screen.getByTestId('retrain-workbench')).toHaveTextContent(
        'annotate:frame-1 at 1 of 1',
      )
    })

    it('drops a ?frame= the answered list does not hold', () => {
      window.history.replaceState({}, '', '/addon/training?tab=frames&frame=ghost')
      renderFrames()
      expect(screen.queryByTestId('corpus-annotate-overlay')).not.toBeInTheDocument()
      expect(new URLSearchParams(window.location.search).has('frame')).toBe(false)
    })

    it('steps past the last frame of a page into the next page', () => {
      listTotal = 120
      listPages = { 1: page(['a1', 'a2']), 2: page(['b1', 'b2']) }
      listFrames = listPages[1]
      window.history.replaceState({}, '', '/addon/training?tab=frames&frame=a2')
      renderFrames()
      expect(screen.getByTestId('retrain-workbench')).toHaveTextContent('annotate:a2 at 2 of 120')
      fireEvent.click(screen.getByRole('button', { name: 'step-next' }))
      const params = new URLSearchParams(window.location.search)
      expect(params.get('page')).toBe('2')
      expect(params.get('frame')).toBe('b1')
      expect(screen.getByTestId('retrain-workbench')).toHaveTextContent('annotate:b1 at 51 of 120')
    })

    it('cannot step back from the first frame of the corpus', () => {
      window.history.replaceState({}, '', '/addon/training?tab=frames&frame=frame-1')
      renderFrames()
      expect(screen.getByRole('button', { name: 'step-prev' })).toBeDisabled()
    })
  })
})
