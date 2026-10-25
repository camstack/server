/**
 * Router-level spec for `modelConvert` — verifies the router factory exposes
 * the `convert` procedure and enforces auth/provider-guard behaviour, mirroring
 * the pattern used by `pipeline-executor.router.spec.ts`.
 */
import { describe, it, expect } from 'vitest'
import type { IModelConvertProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

function makeMockProvider(overrides: Partial<IModelConvertProvider> = {}): IModelConvertProvider {
  return {
    convert: async () => ({
      entry: {
        id: 'test-model',
        name: 'Test Model',
        description: 'desc',
        formats: {},
        inputSize: { width: 640, height: 640 },
        labels: [],
      },
      artifacts: [],
    }),
    ...overrides,
  }
}

const validInput = {
  sourceUrl: 'https://example.com/model.onnx',
  metadata: {
    id: 'test-model',
    name: 'Test Model',
    labels: [],
    inputSize: { width: 640, height: 640 },
    outputFormat: 'yolo' as const,
  },
  targets: [{ format: 'openvino' as const, precisions: ['fp16' as const] }],
}

describe('modelConvert router — procedure surface + guards', () => {
  describe('router shape', () => {
    it('exposes a convert procedure via createCaller', () => {
      const router = buildCapRouterForTest('model-convert', () => makeMockProvider())
      const caller = router.createCaller(makeCtx('admin'))
      expect(typeof caller.convert).toBe('function')
    })
  })

  describe('missing provider', () => {
    it('throws PRECONDITION_FAILED when getProvider returns null', async () => {
      const router = buildCapRouterForTest('model-convert', () => null)
      const outcome = await invokeProcedure(router, 'convert', makeCtx('admin'), validInput)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('PRECONDITION_FAILED')
      }
    })
  })

  describe('auth', () => {
    it('rejects anonymous callers (admin-only mutation)', async () => {
      const router = buildCapRouterForTest('model-convert', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'convert', makeCtx('anonymous'), validInput)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.code).toBe('UNAUTHORIZED')
      }
    })

    it('allows admin to call convert', async () => {
      const router = buildCapRouterForTest('model-convert', () => makeMockProvider())
      const outcome = await invokeProcedure(router, 'convert', makeCtx('admin'), validInput)
      expect(outcome.ok).toBe(true)
    })
  })
})
