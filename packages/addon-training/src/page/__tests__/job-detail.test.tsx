// @vitest-environment jsdom
/**
 * The job detail draws what the record says: a failure by its reason and stage,
 * the cost as an estimate against the cap, the log tail. Cancel is on the table row.
 */
import type { TrainingJob } from '@camstack/types'
import { ConfirmDialogProvider, type AddonPageProps } from '@camstack/ui-library'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JobDetail } from '../JobDetail.js'

afterEach(cleanup)

const BASE: TrainingJob = {
  id: 'j1',
  idempotencyKey: 'k',
  name: 'night fix',
  createdAt: 0,
  updatedAt: 0,
  state: 'running',
  batchId: null,
  stage: 'train',
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
    costUsd: 0.42,
    costIsEstimate: true,
    lastPolledAt: null,
  },
  progress: { epoch: 3, epochs: 40, etaSec: 600, series: [] },
  logTail: ['epoch 3/40'],
  logCursor: null,
  artifacts: null,
  cloudDatasetDeletedAt: null,
  cloudCleanupDueAt: null,
  registeredModelIds: [],
  canary: null,
}

const trpc = {} as AddonPageProps['trpc']

function renderDetail(job: TrainingJob) {
  render(
    <ConfirmDialogProvider>
      <JobDetail
        job={job}
        trpc={trpc}
        onChanged={() => undefined}
        cameraName={(id) => `#${String(id)}`}
        collectionName={(id) => (id === 'col-1' ? 'missed at night' : id)}
      />
    </ConfirmDialogProvider>,
  )
}

describe('JobDetail', () => {
  it('shows progress, collections used, the estimated cost against the cap and the log tail', () => {
    renderDetail(BASE)
    expect(screen.getByText(/Epoch 3 \/ 40/)).toBeTruthy()
    expect(screen.getByTestId('job-detail-collections-j1').textContent).toContain('missed at night')
    expect(screen.getByText(/≈ \$0\.42 of \$3\.00 cap/)).toBeTruthy()
    expect(screen.getByTestId('log-tail').textContent).toContain('epoch 3/40')
  })

  it('names a failure by reason and stage', () => {
    renderDetail({
      ...BASE,
      state: 'failed',
      failure: { reason: 'cost-cap', stage: 'train', detail: 'spent $3.01' },
    })
    expect(screen.getByRole('alert').textContent).toBe('cost-cap during train: spent $3.01')
  })
})
