/**
 * The new-job form → request: nothing is planned until every required pick is
 * made; an empty freeze and an empty holdout mean "the orchestrator decides"
 * (null), never 0 or []; a provider change takes that provider's own defaults.
 */
import type { TrainingProviderDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { defaultBaseModel, EMPTY_FORM, requestOf, withProvider } from '../plan-form.js'

const FULL = {
  ...EMPTY_FORM,
  collectionIds: ['col-1'],
  workState: 'complete' as const,
  entryId: 'modal-entry-default',
  gpuType: 'L4',
  baseModelIds: ['m'],
}

describe('plan form', () => {
  it('plans nothing until every required pick is made', () => {
    expect(requestOf(EMPTY_FORM)).toBeNull()
    expect(requestOf({ ...FULL, gpuType: '' })).toBeNull()
    expect(requestOf({ ...FULL, collectionIds: [] })).toBeNull()
  })

  it('leaves freeze and holdout to the orchestrator when empty', () => {
    expect(requestOf(FULL)).toMatchObject({
      freeze: null,
      holdoutCameras: null,
      selection: { collectionIds: ['col-1'], workState: 'complete' },
    })
    expect(requestOf({ ...FULL, freeze: '5', holdoutCameras: [101] })).toMatchObject({
      freeze: 5,
      holdoutCameras: [101],
    })
  })

  it('refuses a freeze that is not a non-negative integer', () => {
    expect(requestOf({ ...FULL, freeze: '-1' })).toBeNull()
    expect(requestOf({ ...FULL, freeze: '2.5' })).toBeNull()
  })

  it('takes the provider defaults on a provider change', () => {
    const provider = {
      entryId: 'modal-entry-default',
      defaults: {
        gpuType: 'A10G',
        region: 'eu',
        costCapUsd: 5,
        maxRuntimeSec: 1,
        failedDatasetGraceHours: 24,
      },
    } as const satisfies Pick<TrainingProviderDescriptor, 'entryId' | 'defaults'>
    const next = withProvider(FULL, {
      ...provider,
      addonId: 'training-modal',
      typeId: 'modal',
      name: 'Default',
      iconAsset: 'assets/training-modal/icon.svg',
      kind: 'modal',
      label: 'Modal',
      gpuTypes: [],
      regions: [],
      maxDatasetBytes: 1,
      maxRuntimeSec: 1,
      dataResidencyNote: '',
      configured: true,
    })
    expect([next.entryId, next.gpuType, next.region]).toEqual(['modal-entry-default', 'A10G', 'eu'])
  })

  it('defaults the base model to the recommended one', () => {
    expect(
      defaultBaseModel([
        {
          modelId: 'a',
          label: 'a',
          weights: 'a',
          imgsz: 1,
          baselineOnnxUrl: '',
          baselineFloors: {},
          recommended: false,
        },
        {
          modelId: 'b',
          label: 'b',
          weights: 'b',
          imgsz: 1,
          baselineOnnxUrl: '',
          baselineFloors: {},
          recommended: true,
        },
      ]),
    ).toBe('b')
  })
})
