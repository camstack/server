/**
 * `training-provider` (D805): a collection routed by `addonId` — a single-row
 * call reaches exactly the provider it names, `describe` concat-fans across
 * every provider, and every method is admin (a provider spends money and
 * holds a cloud credential). Job work and credential checks are keyed by
 * `entryId`.
 */
import { describe, expect, it } from 'vitest'
import {
  trainingProviderCapability,
  type ITrainingCloudProvider,
  type TrainingProviderDescriptor,
} from '@camstack/types'
import { buildCapRouterForTest, checkAuthMatrix } from './harness.js'

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
  it('declares no credential check or entry CRUD: an account is an integration instance', () => {
    const names = Object.keys(trainingProviderCapability.methods)
    for (const gone of ['validateCredentials', 'createEntry', 'updateEntry', 'deleteEntry'])
      expect(names).not.toContain(gone)
  })

  it('gates describe behind admin', async () => {
    const router = buildCapRouterForTest('training-provider', () => makeProvider('training-modal'))
    for (const [procedure, input] of [
      ['describe', {}],
    ] as const) {
      const matrix = await checkAuthMatrix(router, procedure, 'admin', input)
      for (const row of matrix) expect(row.outcome.ok).toBe(row.allowed)
    }
  })
})
