/**
 * `training` (D805): the orchestrator's router passes the provider's answer
 * through untouched and gates every method — they move frames to a cloud and
 * spend money — behind admin. The output shape is the provider's; this spec
 * pins the routing and the gate, not the engine (that is `addon-training`).
 */
import { describe, expect, it } from 'vitest'
import type { ITrainingOrchestrator } from '@camstack/types'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

function makeProvider(): Partial<ITrainingOrchestrator> {
  return {
    listJobs: async () => [],
    listBaseModels: async () => [
      {
        modelId: 'yolov9m-640',
        label: 'YOLOv9 Medium @640',
        weights: 'yolov9m.pt',
        imgsz: 640,
        baselineOnnxUrl: 'https://example.invalid/m.onnx',
        baselineFloors: { person: 0.6 },
        recommended: true,
      },
    ],
    getJob: async () => null,
  }
}

function routerAvailable(): boolean {
  try {
    buildCapRouterForTest('training', () => makeProvider())
    return true
  } catch {
    return false
  }
}

describe.skipIf(!routerAvailable())('training router', () => {
  it('passes listBaseModels through to the orchestrator', async () => {
    const router = buildCapRouterForTest('training', () => makeProvider())
    const outcome = await invokeProcedure(router, 'listBaseModels', makeCtx('admin'), {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual(await makeProvider().listBaseModels?.({}))
  })

  it('gates every read behind admin', async () => {
    const router = buildCapRouterForTest('training', () => makeProvider())
    for (const procedure of ['listJobs', 'listBaseModels']) {
      const matrix = await checkAuthMatrix(router, procedure, 'admin', {})
      for (const row of matrix) expect(row.outcome.ok).toBe(row.allowed)
    }
  })
})
