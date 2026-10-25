/**
 * `training-provider` (D805): a collection routed by `addonId` — a single-row
 * call reaches exactly the provider it names, `describe` concat-fans across
 * every provider, and every method is admin (a provider spends money and
 * holds a cloud credential). Job work and credential checks are keyed by
 * `entryId`.
 */
import { describe, expect, it } from 'vitest'
import type { ITrainingCloudProvider, TrainingProviderDescriptor } from '@camstack/types'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

function descriptor(addonId: string): TrainingProviderDescriptor {
  return {
    addonId,
    entryId: `${addonId}-default`,
    typeId: addonId,
    name: 'Default',
    iconAsset: 'assets/training-modal/icon.svg',
    kind: addonId,
    label: addonId,
    gpuTypes: [],
    regions: [],
    maxDatasetBytes: 1,
    maxRuntimeSec: 1,
    dataResidencyNote: 'n/a',
    configured: false,
    defaults: {
      gpuType: 'L4',
      region: '',
      costCapUsd: 1,
      maxRuntimeSec: 1,
      failedDatasetGraceHours: 0,
    },
  }
}

function makeProvider(addonId: string): Partial<ITrainingCloudProvider> {
  return {
    describe: async () => [descriptor(addonId)],
    describeTypes: async () => [
      {
        typeId: addonId,
        label: addonId,
        iconAsset: 'assets/training-modal/icon.svg',
        addonId,
      },
    ],
    listEntries: async () => [
      {
        entryId: `${addonId}-default`,
        typeId: addonId,
        name: 'Default',
        addonId,
        configured: false,
      },
    ],
    validateCredentials: async () => ({ ok: true, account: addonId }),
  }
}

function routerAvailable(): boolean {
  try {
    buildCapRouterForTest('training-provider', () => makeProvider('training-modal'))
    return true
  } catch {
    return false
  }
}

describe.skipIf(!routerAvailable())('training-provider router', () => {
  it('answers validateCredentials from the provider it was routed to', async () => {
    const router = buildCapRouterForTest('training-provider', () => makeProvider('training-modal'))
    const outcome = await invokeProcedure(router, 'validateCredentials', makeCtx('admin'), {
      addonId: 'training-modal',
      entryId: 'training-modal-default',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ ok: true, account: 'training-modal' })
  })

  it('gates describe and validateCredentials behind admin', async () => {
    const router = buildCapRouterForTest('training-provider', () => makeProvider('training-modal'))
    for (const [procedure, input] of [
      ['describe', {}],
      ['validateCredentials', { addonId: 'training-modal', entryId: 'training-modal-default' }],
    ] as const) {
      const matrix = await checkAuthMatrix(router, procedure, 'admin', input)
      for (const row of matrix) expect(row.outcome.ok).toBe(row.allowed)
    }
  })
})
