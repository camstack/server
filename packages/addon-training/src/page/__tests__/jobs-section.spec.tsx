// @vitest-environment jsdom
/**
 * Jobs tab — DataTable + ItemFormDialog create (Providers pattern).
 * State filter on the list; no inline New job form.
 */
import type {
  RetrainCollection,
  TrainingBaseModel,
  TrainingJob,
  TrainingProviderDescriptor,
} from '@camstack/types'
import { ConfirmDialogProvider, type AddonPageProps } from '@camstack/ui-library'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobsSection } from '../JobsSection.js'

vi.mock(import('@camstack/ui-library'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useClusterNodes: () => ({ nodes: [], isLoading: false, isError: false }),
  }
})

/** jsdom does not implement HTMLDialogElement.showModal/close. */
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

afterEach(cleanup)

beforeEach(() => {
  installDialogPolyfill()
  window.history.replaceState({}, '', '/addon/training?tab=jobs')
})

const COLLECTION: RetrainCollection = {
  id: 'col-1',
  name: 'missed at night',
  createdAt: 1,
  frameCount: 2,
}

const PROVIDER = {
  entryId: 'modal-entry-default',
  addonId: 'training-modal',
  typeId: 'modal',
  name: 'Default',
  iconAsset: 'assets/training-modal/icon.svg',
  kind: 'modal',
  label: 'Modal',
  gpuTypes: [{ id: 'L4', label: 'L4', usdPerHour: 0.8, vramGb: 24 }],
  regions: [{ id: '', label: 'Any', priceMultiplier: 1 }],
  maxDatasetBytes: 1,
  maxRuntimeSec: 1,
  dataResidencyNote: '',
  configured: true,
  defaults: {
    gpuType: 'L4',
    region: '',
    costCapUsd: 5,
    maxRuntimeSec: 3600,
    failedDatasetGraceHours: 24,
  },
} satisfies TrainingProviderDescriptor

const BASE_MODEL = {
  modelId: 'yolov9m-640',
  label: 'YOLOv9m',
  weights: 'w',
  imgsz: 640,
  baselineOnnxUrl: '',
  baselineFloors: {},
  recommended: true,
} satisfies TrainingBaseModel

function job(
  partial: Partial<TrainingJob> & Pick<TrainingJob, 'id' | 'state' | 'name'>,
): TrainingJob {
  return {
    idempotencyKey: 'k',
    createdAt: 0,
    updatedAt: 0,
    batchId: null,
    stage: null,
    failure: null,
    request: {
      selection: { collectionIds: ['col-1'], workState: 'complete' },
      entryId: 'modal-entry-default',
      gpuType: 'L4',
      region: '',
      baseModelId: 'yolov9m-640',
      preset: 'standard',
      freeze: null,
      holdoutCameras: null,
    },
    maxCostUsd: 3,
    maxRuntimeSec: 3600,
    trainer: { repo: 'r', revision: 'abcdef1' },
    datasetLayout: 'frames',
    frameCount: 10,
    frameIds: ['f0'],
    annotationHash: 'h',
    dataset: null,
    split: { holdoutCameras: [], holdoutLastDays: 3, holdoutSupport: null, trainSubjects: 1 },
    provider: {
      state: 'running',
      providerJobId: 'p',
      startedAt: null,
      endedAt: null,
      billedSeconds: 0,
      costUsd: 0,
      costIsEstimate: true,
      lastPolledAt: null,
    },
    progress: { epoch: null, epochs: null, etaSec: null, series: [] },
    logTail: [],
    logCursor: null,
    artifacts: null,
    cloudDatasetDeletedAt: null,
    cloudCleanupDueAt: null,
    registeredModelIds: [],
    canary: null,
    ...partial,
  }
}

const JOBS: readonly TrainingJob[] = [
  job({ id: 'j-run', name: 'running one', state: 'running', stage: 'train' }),
  job({
    id: 'j-fail',
    name: 'failed one',
    state: 'failed',
    failure: { reason: 'cost-cap', stage: 'train', detail: 'spent' },
  }),
]

function mockTrpc(): AddonPageProps['trpc'] {
  return {
    pipelineOrchestrator: {
      getNodeInferenceDevices: { query: async () => [] },
    },
    pipelineExecutor: {
      getSchema: { query: async () => ({ slots: [] }) },
    },
    training: {
      planJob: {
        query: async () => ({
          refusal: null,
          dataNotice: 'Frames leave the hub.',
          defaults: { maxCostUsd: 5, maxRuntimeSec: 3600 },
          split: { holdoutCameras: [] },
        }),
      },
      startJob: {
        mutate: async () => ({ kind: 'started', job: { id: 'j-new' } }),
      },
      startJobBatch: {
        mutate: async () => ({ kind: 'started', jobIds: ['j-new'] }),
      },
      cancelJob: { mutate: async () => ({ ok: true }) },
    },
  } as unknown as AddonPageProps['trpc']
}

function renderJobs(
  list: readonly TrainingJob[] = JOBS,
  deps: {
    readonly depsPending?: boolean
    readonly depsError?: string | null
    readonly createRequested?: boolean
  } = {},
) {
  return render(
    <ConfirmDialogProvider>
      <JobsSection
        trpc={mockTrpc()}
        providers={deps.depsError !== undefined && deps.depsError !== null ? null : [PROVIDER]}
        baseModels={deps.depsError !== undefined && deps.depsError !== null ? null : [BASE_MODEL]}
        collections={deps.depsError !== undefined && deps.depsError !== null ? null : [COLLECTION]}
        jobs={{ status: 'ok', data: list }}
        onJobsReload={vi.fn()}
        cameraName={(id) => `#${String(id)}`}
        depsPending={deps.depsPending ?? false}
        depsError={deps.depsError ?? null}
        createRequested={deps.createRequested ?? false}
        onCreateConsumed={vi.fn()}
      />
    </ConfirmDialogProvider>,
  )
}

describe('JobsSection', () => {
  it('does not show an inline New job form — only the jobs table', () => {
    renderJobs()
    expect(screen.queryByRole('heading', { name: 'New job' })).toBeNull()
    expect(screen.getByTestId('job-j-run')).toBeTruthy()
  })

  it('Add opens the create dialog with base model picker', async () => {
    renderJobs(JOBS, { createRequested: true })
    const dialog = await screen.findByTestId('job-create-dialog')
    expect(within(dialog).getByText(/Provider entry/i)).toBeTruthy()
    expect(within(dialog).getByTestId('training-base-model-picker')).toBeTruthy()
    expect(within(dialog).getByText(/exports ONNX/i)).toBeTruthy()
  })

  it('filters the list by job state only', () => {
    renderJobs()
    expect(screen.getByTestId('job-j-run')).toBeTruthy()
    expect(screen.getByTestId('job-j-fail')).toBeTruthy()
    expect(screen.queryByLabelText(/camera/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    expect(screen.queryByTestId('job-j-run')).toBeNull()
    expect(screen.getByTestId('job-j-fail')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByTestId('job-j-run')).toBeTruthy()
    expect(screen.getByTestId('job-j-fail')).toBeTruthy()
  })

  it('shows collections used on each job row', () => {
    renderJobs()
    expect(screen.getByTestId('job-collections-j-run').textContent).toContain('missed at night')
    expect(screen.getByTestId('job-collections-j-fail').textContent).toContain('missed at night')
  })

  it('offers Cancel on a running row and not on a failed one', () => {
    renderJobs()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('shows a fetch error banner when deps failed, without blocking the table', async () => {
    renderJobs(JOBS, {
      depsPending: false,
      depsError: 'providers: network down',
    })
    expect(screen.queryByText(/Loading providers and collections/i)).toBeNull()
    expect(screen.getByText(/Could not load job setup/i)).toBeTruthy()
    expect(screen.getByText(/providers: network down/i)).toBeTruthy()
    expect(screen.getByTestId('job-j-run')).toBeTruthy()
  })

  it('keeps a loading hint while deps are still pending', () => {
    render(
      <ConfirmDialogProvider>
        <JobsSection
          trpc={mockTrpc()}
          providers={null}
          baseModels={null}
          collections={null}
          jobs={{ status: 'ok', data: [] }}
          onJobsReload={vi.fn()}
          cameraName={(id) => `#${String(id)}`}
          depsPending
          depsError={null}
        />
      </ConfirmDialogProvider>,
    )
    expect(screen.getByText(/Loading providers and collections/i)).toBeTruthy()
    expect(screen.queryByTestId('job-create-dialog')).toBeNull()
  })

  it('create dialog does not open until deps are ready', async () => {
    render(
      <ConfirmDialogProvider>
        <JobsSection
          trpc={mockTrpc()}
          providers={null}
          baseModels={null}
          collections={null}
          jobs={{ status: 'ok', data: [] }}
          onJobsReload={vi.fn()}
          cameraName={(id) => `#${String(id)}`}
          depsPending
          depsError={null}
          createRequested
          onCreateConsumed={vi.fn()}
        />
      </ConfirmDialogProvider>,
    )
    await waitFor(() => {
      expect(screen.queryByTestId('job-create-dialog')).toBeNull()
    })
  })
})
