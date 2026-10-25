/**
 * Dataset freeze / version APIs are gone; plan/start takes a live
 * TrainingCorpusSelection instead of datasetVersionId.
 *
 * Imports the worktree `.cap.ts` sources directly — this worktree's
 * `node_modules` symlink resolves `@camstack/types` to the main clone's dist.
 */
import { describe, expect, it } from 'vitest'
import { pipelineAnalyticsCapability } from '../../../types/src/capabilities/pipeline-analytics.cap.js'
import { trainingCapability } from '../../../types/src/capabilities/training.cap.js'

describe('dataset freeze removal', () => {
  it('pipeline-analytics no longer exposes freeze methods', () => {
    const methods = pipelineAnalyticsCapability.methods
    expect('previewRetrainDataset' in methods).toBe(false)
    expect('createRetrainDatasetVersion' in methods).toBe(false)
    expect('listRetrainDatasetVersions' in methods).toBe(false)
    expect('deleteRetrainDatasetVersion' in methods).toBe(false)
    expect('verifyRetrainDatasetVersion' in methods).toBe(false)
    expect('resolveRetrainTrainingCorpus' in methods).toBe(true)
  })

  it('training no longer exposes dataset-version row methods', () => {
    const methods = trainingCapability.methods
    expect('putDatasetVersion' in methods).toBe(false)
    expect('getDatasetVersion' in methods).toBe(false)
    expect('listDatasetVersions' in methods).toBe(false)
    expect('findDatasetVersionIdByName' in methods).toBe(false)
    expect('removeDatasetVersion' in methods).toBe(false)
  })

  it('training job request carries selection, not datasetVersionId', () => {
    const shape = trainingCapability.methods.planJob.input
    const parsed = shape.safeParse({
      selection: { collectionIds: ['c1'] },
      entryId: 'fake-default',
      gpuType: 'L4',
      region: '',
      baseModelId: 'yolov9m-640',
      preset: 'standard',
      freeze: null,
      holdoutCameras: null,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.selection.workState).toBe('complete')
      expect('datasetVersionId' in parsed.data).toBe(false)
    }
  })
})
