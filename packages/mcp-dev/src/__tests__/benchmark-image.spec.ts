/**
 * `benchmark_image_run` — the Benchmark page's Image run from the MCP: the
 * existing `runPipelineTest` custom action, mapped from (node, device, model),
 * behind the mutation gate, answered with a bounded summary.
 */
import type { HubClient } from '@camstack/develop'
import { MutationGate, parseApiIndex } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import {
  benchmarkImageRun,
  imageRunCall,
  summarizeImageRun,
  type ImageRunArgs,
} from '../models/benchmark-image.js'
import { createGatedMutator } from '../ops/hub.js'
import { auditLog, fakeMutator } from './model-fakes.js'

const ARGS: ImageRunArgs = { nodeId: 'agent-1', deviceKey: 'openvino:npu', modelId: 'yolo11n' }

function gate(): MutationGate {
  let n = 0
  return new MutationGate({
    allowMutations: true,
    audit: auditLog().sink,
    newToken: () => `cfm_${++n}`,
  })
}

describe('imageRunCall — the input the Image section sends', () => {
  it('maps node, device and model, with the latency harness defaults', () => {
    expect(imageRunCall(ARGS)).toEqual({
      addonId: 'benchmark',
      action: 'runPipelineTest',
      input: {
        nodeId: 'agent-1',
        deviceKey: 'openvino:npu',
        referenceImage: '3-persons.jpg',
        plane: 'frame',
        steps: [{ addonId: 'object-detection', enabled: true, modelId: 'yolo11n', children: [] }],
      },
    })
  })

  it('passes an explicit step, image and plane through', () => {
    const call = imageRunCall({
      ...ARGS,
      step: 'face-detection',
      referenceImage: 'faces.jpg',
      plane: 'full',
    })
    expect(call.input).toMatchObject({ referenceImage: 'faces.jpg', plane: 'full' })
    expect(call.input.steps[0].addonId).toBe('face-detection')
  })
})

describe('summarizeImageRun — a bounded answer', () => {
  it('reads the step latency first, counts and caps the detections', () => {
    const detections = Array.from({ length: 25 }, (_, i) => ({
      class: 'person',
      score: 0.9,
      box: [i, i, 10, 10],
      debug: i === 0 ? { stepLatencyMs: { 'object-detection': 12.5 } } : {},
    }))
    const s = summarizeImageRun(
      ARGS,
      {
        kind: 'ok',
        detections,
        debug: { predictMs: 99, stepTimings: [{ source: 'object-detection', ms: 14 }] },
      },
      300,
    )
    expect(s).toMatchObject({
      nodeId: 'agent-1',
      deviceKey: 'openvino:npu',
      modelId: 'yolo11n',
      step: 'object-detection',
      kind: 'ok',
      inferMs: 12.5,
      wallMs: 300,
      detections: 25,
      discarded: 0,
      stepTimings: [{ source: 'object-detection', ms: 14 }],
    })
    expect(s.topDetections).toHaveLength(10)
    expect(s.topDetections[0]).toEqual({ class: 'person', score: 0.9 })
    expect(JSON.stringify(s)).not.toMatch(/box/)
  })

  it('falls back to the step timing, then predictMs; null when the answer has none', () => {
    expect(
      summarizeImageRun(
        ARGS,
        { debug: { stepTimings: [{ source: 'object-detection', ms: 7 }], predictMs: 9 } },
        1,
      ).inferMs,
    ).toBe(7)
    expect(summarizeImageRun(ARGS, { debug: { predictMs: 9 } }, 1).inferMs).toBe(9)
    expect(summarizeImageRun(ARGS, 'garbage', 1)).toMatchObject({
      inferMs: null,
      kind: null,
      detections: 0,
    })
  })
})

describe('benchmarkImageRun — dry run, token, run', () => {
  it('the dry run warns about the load and never calls the hub; the token runs it once', async () => {
    const mutator = fakeMutator({
      'addons.custom': { kind: 'ok', detections: [], debug: { predictMs: 5 } },
    })
    let t = 1000
    const deps = { gate: gate(), mutator: () => mutator, now: () => (t += 40) }
    const dry = await benchmarkImageRun(deps, ARGS, undefined)
    expect(dry.status).toBe('dry-run')
    expect(JSON.stringify(dry)).toMatch(/loads that node/)
    expect(mutator.calls).toHaveLength(0)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const done = await benchmarkImageRun(deps, ARGS, dry.confirm_token)
    expect(done).toMatchObject({ status: 'executed', result: { inferMs: 5, wallMs: 40 } })
    expect(mutator.calls).toEqual([{ path: 'addons.custom', input: imageRunCall(ARGS) }])
  })
})

describe('the mutator allow-list admits the benchmark Image run only', () => {
  const INDEX = parseApiIndex('| `addons.custom` | mutation | admin | addons |')
  it('lets runPipelineTest through and refuses any other benchmark action', async () => {
    const sent: unknown[] = []
    const client: HubClient = {
      async call(_m, _p, input) {
        sent.push(input)
        return {}
      },
    }
    const mutator = createGatedMutator({
      server: 'https://h.test',
      tier: 'admin',
      index: INDEX,
      client,
    })
    await mutator.mutate('addons.custom', imageRunCall(ARGS))
    await expect(
      mutator.mutate('addons.custom', { addonId: 'benchmark', action: 'deleteResults', input: {} }),
    ).rejects.toThrow(/not allow-listed/)
    expect(sent).toHaveLength(1)
  })
})
