/**
 * Where a rebuild's work lands, and what the pass does when a node stops being
 * able to do it.
 *
 * The properties under test are the ones an operator cannot check by looking at
 * the index afterwards:
 *
 * - the work SPREADS (a pass that silently ran entirely on the hub looks
 *   identical in the output);
 * - one MODEL for the whole pass, and a node that would run another is retired
 *   rather than believed;
 * - a node that drops out mid-pass costs the pass a node, never a track;
 * - when nothing is left the pass STOPS and says so, instead of spinning or
 *   quietly reporting a clean run over nothing.
 */

import type { RunStatelessStepInput, RunStatelessStepResult } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { RebuildSource } from '../embedding-rebuild.js'
import { NodeRotation } from '../rebuild-node-rotation.js'
import { RebuildStepDispatcher } from '../rebuild-step-dispatch.js'

const PINNED_MODEL = 'mobileclip-s1'
const EMBEDDING = Buffer.from(Float32Array.from([1, 0, 0]).buffer).toString('base64')

function makeSource(overrides: Partial<RebuildSource> = {}): RebuildSource {
  return {
    trackId: 't1',
    deviceId: 102,
    timestamp: 1,
    className: 'person',
    confidence: 0.8,
    keyFrame: Buffer.from('jpeg'),
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
    boxSource: { kind: 'subjectBox' },
    ...overrides,
  }
}

function embedded(nodeId: string, modelId = PINNED_MODEL): RunStatelessStepResult {
  return {
    kind: 'ran',
    nodeId,
    modelId,
    details: [{ stepId: 'clip-embedding', className: 'embedding', score: 1, embedding: EMBEDDING }],
  }
}

function refused(
  nodeId: string,
  reason: Extract<RunStatelessStepResult, { kind: 'refused' }>['reason'],
): RunStatelessStepResult {
  return { kind: 'refused', nodeId, reason, detail: `${nodeId} says ${reason}` }
}

interface Harness {
  readonly dispatcher: RebuildStepDispatcher
  readonly call: ReturnType<
    typeof vi.fn<(nodeId: string, input: RunStatelessStepInput) => Promise<RunStatelessStepResult>>
  >
  readonly warn: ReturnType<typeof vi.fn>
}

function makeHarness(
  nodeIds: readonly string[],
  impl: (nodeId: string, input: RunStatelessStepInput) => Promise<RunStatelessStepResult>,
): Harness {
  const call = vi.fn(impl)
  const warn = vi.fn()
  return {
    call,
    warn,
    dispatcher: new RebuildStepDispatcher(
      { runStatelessStep: call, logger: { warn } },
      new NodeRotation(nodeIds),
      PINNED_MODEL,
    ),
  }
}

describe('NodeRotation', () => {
  it('rotates rather than favouring the first node', () => {
    // The device balancer's node tier breaks a tie lexicographically, which is
    // right there and starvation here: every candidate scores 0 at dispatch, so
    // the tie-break would hand the whole pass to the alphabetically-first node.
    const rotation = new NodeRotation(['hub', 'agent-a', 'agent-b'])
    expect([rotation.next(), rotation.next(), rotation.next(), rotation.next()]).toEqual([
      'hub',
      'agent-a',
      'agent-b',
      'hub',
    ])
  })

  it('de-duplicates, so an operator override naming a listed node does not double its share', () => {
    const rotation = new NodeRotation(['hub', 'hub', 'agent-a'])
    expect(rotation.live).toEqual(['hub', 'agent-a'])
  })

  it('a dropped node never comes back, and its reason is kept', () => {
    const rotation = new NodeRotation(['hub', 'agent-a'])
    rotation.drop('hub', 'no tflite build')
    expect([rotation.next(), rotation.next()]).toEqual(['agent-a', 'agent-a'])
    expect(rotation.dropped).toEqual([{ nodeId: 'hub', reason: 'no tflite build' }])
  })

  it('dropping does not make the rotation SKIP the node that shifted into its place', () => {
    // A silent skip starves one node for the rest of the pass and shows up
    // nowhere: the counters and the log both look normal.
    const rotation = new NodeRotation(['a', 'b', 'c'])
    expect(rotation.next()).toBe('a')
    rotation.drop('a', 'gone')
    expect([rotation.next(), rotation.next(), rotation.next()]).toEqual(['b', 'c', 'b'])
  })

  it('an empty rotation is exhausted and answers null, never undefined behaviour', () => {
    const rotation = new NodeRotation([])
    expect(rotation.exhausted).toBe(true)
    expect(rotation.next()).toBeNull()
  })

  it('dropping an unknown node is a no-op, not a phantom entry', () => {
    const rotation = new NodeRotation(['hub'])
    rotation.drop('ghost', 'never existed')
    expect(rotation.dropped).toEqual([])
    expect(rotation.live).toEqual(['hub'])
  })
})

describe('RebuildStepDispatcher', () => {
  it('(a) spreads consecutive tracks across the fleet', async () => {
    const { dispatcher, call } = makeHarness(['hub', 'agent-a', 'agent-b'], async (nodeId) =>
      embedded(nodeId),
    )
    for (let i = 0; i < 4; i++) await dispatcher.embed(makeSource({ trackId: `t${i}` }))

    expect(call.mock.calls.map((c) => c[0])).toEqual(['hub', 'agent-a', 'agent-b', 'hub'])
  })

  it('(b) sends the pinned model with every request', async () => {
    const { dispatcher, call } = makeHarness(['hub', 'agent-a'], async (nodeId) => embedded(nodeId))
    await dispatcher.embed(makeSource())
    await dispatcher.embed(makeSource())

    for (const [, input] of call.mock.calls) expect(input.modelId).toBe(PINNED_MODEL)
  })

  it('(c) a node that cannot serve the pin is RETIRED and the SAME track is retried', async () => {
    const { dispatcher, call, warn } = makeHarness(['hub', 'agent-a'], async (nodeId) =>
      nodeId === 'hub' ? refused('hub', 'model-not-servable') : embedded(nodeId),
    )
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome).toEqual({ kind: 'embedded', embeddingBase64: EMBEDDING })
    expect(call.mock.calls.map((c) => c[0])).toEqual(['hub', 'agent-a'])
    expect(dispatcher.liveNodes).toEqual(['agent-a'])
    expect(dispatcher.droppedNodes.map((d) => d.nodeId)).toEqual(['hub'])
    // Loud: a fleet that quietly shrinks to one node is an invisible slowdown.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]?.tags?.deviceId).toBe(102)
  })

  it('(d) a node that ran ANOTHER model is retired, and its vector is not used', async () => {
    // The node should have refused. That it did not means it ignored the pin,
    // and the vector it produced belongs to a different feature space.
    const { dispatcher } = makeHarness(['hub', 'agent-a'], async (nodeId) =>
      nodeId === 'hub' ? embedded('hub', 'mobileclip-s0') : embedded(nodeId),
    )
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome).toEqual({ kind: 'embedded', embeddingBase64: EMBEDDING })
    expect(dispatcher.droppedNodes.map((d) => d.nodeId)).toEqual(['hub'])
  })

  it('(e) a node that drops out mid-pass costs a NODE, not the track', async () => {
    const { dispatcher, call } = makeHarness(['hub', 'agent-a'], async (nodeId) => {
      if (nodeId === 'hub') throw new Error('node-offline')
      return embedded(nodeId)
    })
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome.kind).toBe('embedded')
    expect(call.mock.calls.map((c) => c[0])).toEqual(['hub', 'agent-a'])
    expect(dispatcher.droppedNodes[0]?.reason).toContain('node-offline')
  })

  it('(f) when every node has left, the answer is NO-CAPABLE-NODE and it names them', async () => {
    const { dispatcher, call } = makeHarness(['hub', 'agent-a'], async (nodeId) =>
      refused(nodeId, 'model-not-servable'),
    )
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome.kind).toBe('no-capable-node')
    if (outcome.kind === 'no-capable-node') {
      expect(outcome.reason).toContain('hub')
      expect(outcome.reason).toContain('agent-a')
    }
    // Bounded: each candidate is offered the track exactly once.
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('(g) an empty candidate list is NO-CAPABLE-NODE without a single call', async () => {
    const { dispatcher, call } = makeHarness([], async (nodeId) => embedded(nodeId))
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome.kind).toBe('no-capable-node')
    expect(call).not.toHaveBeenCalled()
  })

  it('(h) a track-level refusal keeps the node — it is the media that is bad', async () => {
    const { dispatcher, call } = makeHarness(['hub', 'agent-a'], async (nodeId) =>
      refused(nodeId, 'unreadable-frame'),
    )
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome.kind).toBe('not-runnable')
    // Retrying an unreadable key frame elsewhere reproduces it exactly.
    expect(call).toHaveBeenCalledTimes(1)
    expect(dispatcher.liveNodes).toEqual(['hub', 'agent-a'])
  })

  it('(i) an engine failure keeps the node and counts as FAILED', async () => {
    const { dispatcher, call } = makeHarness(['hub'], async (nodeId) =>
      refused(nodeId, 'execution-failed'),
    )
    const outcome = await dispatcher.embed(makeSource())

    expect(outcome.kind).toBe('failed')
    expect(call).toHaveBeenCalledTimes(1)
    expect(dispatcher.liveNodes).toEqual(['hub'])
  })

  it('(j) a source with no key frame never reaches a node', async () => {
    const { dispatcher, call } = makeHarness(['hub'], async (nodeId) => embedded(nodeId))
    const outcome = await dispatcher.embed(makeSource({ keyFrame: null }))

    expect(outcome.kind).toBe('failed')
    expect(call).not.toHaveBeenCalled()
  })

  it('(k) once the fleet is spent, later tracks answer immediately without calling', async () => {
    const { dispatcher, call } = makeHarness(['hub'], async (nodeId) =>
      refused(nodeId, 'unknown-step'),
    )
    await dispatcher.embed(makeSource({ trackId: 't1' }))
    call.mockClear()
    const second = await dispatcher.embed(makeSource({ trackId: 't2' }))

    expect(second.kind).toBe('no-capable-node')
    expect(call).not.toHaveBeenCalled()
  })
})
