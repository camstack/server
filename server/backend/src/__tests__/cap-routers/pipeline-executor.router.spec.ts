/**
 * Router-level spec for `pipelineExecutor` — covers the reference-media
 * and audio-capabilities endpoints that remain on the cap after the
 * benchmark methods moved to `@camstack/addon-benchmark` (2026-04-14,
 * dispatched via `api.addons.custom`). The full benchmark E2E surface
 * is now tested inside the benchmark addon's own spec files.
 */
import { describe, it, expect } from 'vitest'
import type { InferProvider, pipelineExecutorCapability } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** What the router dispatches to — the cap's own provider type, not the hand-written twin. */
type IPipelineExecutorProvider = InferProvider<typeof pipelineExecutorCapability>

/**
 * The methods this spec's routes reach. The harness takes any provider object;
 * a method left out is a route this spec does not exercise.
 */
function makeMockProvider(
  overrides: Partial<IPipelineExecutorProvider> = {},
): Partial<IPipelineExecutorProvider> {
  const defaultEngine = { runtime: 'python' as const, backend: 'cpu', format: 'onnx' as const }

  return {
    getAvailableEngines: async () => [defaultEngine],
    getSelectedEngine: async () => defaultEngine,
    getSchema: async () => ({
      availableEngines: [
        { engine: defaultEngine, devices: [{ id: 'cpu', label: 'CPU' }], defaultDevice: 'cpu' },
      ],
      selectedEngine: defaultEngine,
      slots: [],
    }),
    getOrchestratorConfigSchema: async () => ({ sections: [] }),
    // Not exercised here (the benchmark surface lives in its own addon's
    // specs): a call refuses loudly instead of answering a made-up shape.
    getCapabilities: async () => {
      throw new Error('getCapabilities is not exercised by this spec')
    },
    downloadModel: async () => ({ filePath: '', sizeMB: 0, durationMs: 0 }),
    deleteModel: async () => ({ success: true as const }),
    runPipeline: async () => {
      throw new Error('runPipeline is not exercised by this spec')
    },
    listReferenceImages: async () => [],
    getReferenceImage: async () => null,
    getReferenceAudioFiles: async () => [{ filename: 'car.wav', sizeKb: 12 }],
    getReferenceAudio: async () => ({ base64: 'AAAA' }),
    getAudioCapabilities: async () => ({
      activeBackend: 'yamnet-onnx',
      availableBackends: [
        { id: 'yamnet-onnx', name: 'YAMNet ONNX', description: '', available: true },
      ],
      sampleRate: 16000,
      chunkDurationMs: 500,
    }),
    // A healthy executor refuses nothing. The EMPTY answer is load-bearing: it
    // is what re-admits a device, and it must never be confused with a failed
    // read (which rejects).
    getInferenceDeviceHealth: async () => ({ unhealthy: [] }),
    rearmInferenceDevice: async () => ({ rearmed: true }),
    ...overrides,
  }
}

describe('pipelineExecutor router (runtime builder) — reference + audio endpoints', () => {
  describe('listReferenceImages', () => {
    it('delegates to provider.listReferenceImages', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () =>
        makeMockProvider({
          listReferenceImages: () =>
            [
              { id: 'persons-cars-animal.jpg', filename: 'persons-cars-animal.jpg', sizeKB: 120 },
            ] as never,
        }),
      )

      const outcome = await invokeProcedure(router, 'listReferenceImages', makeCtx('admin'))
      expect(outcome.ok).toBe(true)
    })
  })

  describe('getAudioCapabilities', () => {
    it('returns backend list from provider', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'getAudioCapabilities', makeCtx('admin'))
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        const caps = outcome.value as { activeBackend: string; sampleRate: number }
        expect(caps.activeBackend).toBe('yamnet-onnx')
        expect(caps.sampleRate).toBe(16000)
      }
    })
  })

  describe('inference-device liveness — the routing channel', () => {
    /**
     * The orchestrator's whole safety argument rests on the two answers being
     * DISTINGUISHABLE at the wire: an empty `unhealthy` re-admits every device,
     * a rejection changes nothing. A router that turned one into the other
     * would silently feed a dead accelerator again.
     */
    it('passes the executor’s refused-device list through unchanged', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () =>
        makeMockProvider({
          getInferenceDeviceHealth: async () => ({
            unhealthy: [
              {
                deviceKey: 'openvino:gpu',
                state: 'failed' as const,
                since: 1,
                deaths: 3,
                lastError: 'longjmp abort',
              },
            ],
          }),
        }),
      )
      const outcome = await invokeProcedure(router, 'getInferenceDeviceHealth', makeCtx('admin'), {
        nodeId: 'hub',
      })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        const health = outcome.value as { unhealthy: readonly { deviceKey: string }[] }
        expect(health.unhealthy.map((u) => u.deviceKey)).toEqual(['openvino:gpu'])
      }
    })

    it('a healthy node answers an EMPTY list, not an error', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'getInferenceDeviceHealth', makeCtx('admin'), {
        nodeId: 'hub',
      })
      expect(outcome).toEqual({ ok: true, value: { unhealthy: [] } })
    })

    it('re-arm is an admin mutation and reports whether anything was cleared', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => makeMockProvider())
      const input = { nodeId: 'hub', deviceKey: 'openvino:gpu' }
      const admin = await invokeProcedure(router, 'rearmInferenceDevice', makeCtx('admin'), input)
      expect(admin).toEqual({ ok: true, value: { rearmed: true } })
      const viewer = await invokeProcedure(router, 'rearmInferenceDevice', makeCtx('user'), input)
      expect(viewer.ok).toBe(false)
    })
  })

  describe('missing provider', () => {
    it('throws PRECONDITION_FAILED when getProvider returns null', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => null)
      const outcome = await invokeProcedure(router, 'listReferenceImages', makeCtx('admin'))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('PRECONDITION_FAILED')
      }
    })
  })

  describe('auth', () => {
    it('rejects anonymous on listReferenceImages (protected query)', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'listReferenceImages', makeCtx('anonymous'))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.code).toBe('UNAUTHORIZED')
    })

    it('allows viewer to read reference images (protected query)', async () => {
      const router = buildCapRouterForTest('pipeline-executor', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'listReferenceImages', makeCtx('user'))
      expect(outcome.ok).toBe(true)
    })
  })
})
