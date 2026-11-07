/**
 * The rescore scheduler's interval is an orchestrator CLUSTER value (D986 §7): the wiring reads it
 * through `addonSettings.readScopedValues({ addonId, cap, scope: 'cluster' })` — the same key
 * (`faceRescoreIntervalMinutes`) the old `getGlobalSettings` walk read — and a failed read skips the
 * tick instead of guessing an interval (D49).
 */
import { FACE_RESCORE_INTERVAL_KEY } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { wireFaceLedger } from '../store/event-ledger-wiring.js'
import { FaceStore } from '../store/face-store.js'
import { IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { IdentityStore } from '../store/identity-store.js'
import { buildFaceRescoreRuntime, type FaceRescoreRuntimeApi } from '../face-rescore-wiring.js'
import { makeAnalyticsWorld } from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

interface ScopedCall {
  readonly addonId: string
  readonly cap: string
  readonly scope: 'cluster'
}

async function runtimeReading(
  answer: () => Record<string, unknown> | null,
  calls: ScopedCall[],
): Promise<ReturnType<typeof buildFaceRescoreRuntime>> {
  const logger = makeSilentLogger()
  const { world, ledgers } = await makeAnalyticsWorld()
  const api: FaceRescoreRuntimeApi = {
    addonSettings: {
      readScopedValues: {
        query: async (input: ScopedCall) => {
          calls.push(input)
          return answer()
        },
      },
    },
  }
  return buildFaceRescoreRuntime(
    {
      api,
      faceStore: new FaceStore({
        vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
        logger,
        faceLedger: wireFaceLedger({ records: world.records }),
      }),
      identityStore: new IdentityStore({
        identityLedger: ledgers.identities,
        sampleLedger: ledgers.identitySamples,
        vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
        logger,
      }),
      state: { load: async () => null, save: async () => undefined },
      logger,
      paramsForDevice: async () => {
        throw new Error('not reached')
      },
    },
    0,
  )
}

describe('buildFaceRescoreRuntime — the interval is a scoped cluster read', () => {
  it('reads the orchestrator cluster form and honours the stored interval (0 = off)', async () => {
    const calls: ScopedCall[] = []
    const runtime = await runtimeReading(() => ({ [FACE_RESCORE_INTERVAL_KEY]: 0 }), calls)
    expect(await runtime.scheduler.tick()).toBe('disabled')
    expect(calls).toEqual([
      { addonId: 'pipeline-orchestrator', cap: 'pipeline-orchestrator', scope: 'cluster' },
    ])
  })

  it('a failed read skips the tick; it never becomes an interval', async () => {
    const runtime = await runtimeReading(() => {
      throw new Error('hub unreachable')
    }, [])
    expect(await runtime.scheduler.tick()).toBe('setting-unreadable')
  })
})
