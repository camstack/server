import { describe, expect, it } from 'vitest'
import type { AddonPageProps } from '@camstack/ui-library'
import { setClusterStepModel } from '../ui/api.js'

describe('setClusterStepModel', () => {
  it('writes the cluster scope of the orchestrator cap through updateScopedSettings', async () => {
    const calls: unknown[] = []
    const surface = {
      addonSettings: {
        updateScopedSettings: {
          mutate: async (input: unknown) => {
            calls.push(input)
            return { ok: true }
          },
        },
      },
    }
    await setClusterStepModel(surface as unknown as AddonPageProps['trpc'], { detector: 'm1' })
    expect(calls).toEqual([
      {
        addonId: 'pipeline-orchestrator',
        cap: 'pipeline-orchestrator',
        scope: 'cluster',
        patch: { detector: 'm1' },
      },
    ])
  })
})
