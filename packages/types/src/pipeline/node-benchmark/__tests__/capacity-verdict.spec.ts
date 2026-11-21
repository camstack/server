/**
 * The node capacity verdict: detection capacity is the node total over its
 * devices at the model each runs NOW, decode capacity is the node's measured
 * streams, and the verdict is the smaller of the two — naming which one
 * limits. An absent measurement is null, never zero (D393).
 */
import { describe, expect, it } from 'vitest'
import type { NodeMeasuredCapacity } from '../../load-balancing/capacity-shares.js'
import {
  type NodeDecodeCapacity,
  NodeCapacityVerdictSchema,
  nodeCapacityVerdicts,
} from '../capacity-verdict.js'

function measured(
  nodeId: string,
  devices: NodeMeasuredCapacity['devices'],
): [string, NodeMeasuredCapacity] {
  return [nodeId, { nodeId, devices }]
}

const DECODE: NodeDecodeCapacity = {
  maxStreams: 6,
  measuredAtMs: 900,
  profile: { width: 3840, height: 2160, fps: 15, codec: 'h265' },
  hardware: true,
  decoder: 'hevc_vaapi',
}

describe('nodeCapacityVerdicts', () => {
  it('sums the devices at the model each runs now and ignores cells for another model', () => {
    const out = nodeCapacityVerdicts({
      runs: [
        { nodeId: 'n1', deviceKey: 'openvino:npu', modelId: 'yolov9s-640' },
        { nodeId: 'n1', deviceKey: 'openvino:gpu', modelId: 'yolov9t-640' },
        { nodeId: 'n1', deviceKey: 'cpu', modelId: 'yolov9t-640' },
      ],
      measured: new Map([
        measured('n1', [
          {
            deviceKey: 'openvino:npu',
            modelId: 'yolov9s-640',
            maxSessions: 4,
            measuredAtMs: 100,
            phase: 'pipeline',
          },
          // Another model on the same device: says nothing about what runs now.
          {
            deviceKey: 'openvino:npu',
            modelId: 'yolov9c-640',
            maxSessions: 99,
            measuredAtMs: 500,
            phase: 'pipeline',
          },
          {
            deviceKey: 'openvino:gpu',
            modelId: 'yolov9t-640',
            maxSessions: 3,
            measuredAtMs: 300,
            phase: 'device',
          },
          // `cpu` has a cell only for a model it does not run: contributes nothing.
          {
            deviceKey: 'cpu',
            modelId: 'yolov9s-640',
            maxSessions: 50,
            measuredAtMs: 400,
            phase: 'device',
          },
        ]),
      ]),
      decode: new Map(),
    })
    expect(out).toEqual([
      {
        nodeId: 'n1',
        detection: {
          maxSessions: 7,
          measuredAtMs: 300,
          cells: [
            { deviceKey: 'openvino:gpu', modelId: 'yolov9t-640', phase: 'device', maxSessions: 3 },
            {
              deviceKey: 'openvino:npu',
              modelId: 'yolov9s-640',
              phase: 'pipeline',
              maxSessions: 4,
            },
          ],
        },
        decode: null,
        capacity: 7,
        limitedBy: null,
        complete: false,
      },
    ])
    for (const verdict of out) expect(NodeCapacityVerdictSchema.parse(verdict)).toEqual(verdict)
  })

  it('reads a node whose only cells are for models it does not run as unmeasured, never zero', () => {
    const out = nodeCapacityVerdicts({
      runs: [{ nodeId: 'n1', deviceKey: 'cpu', modelId: 'yolov9t-640' }],
      measured: new Map([
        measured('n1', [
          {
            deviceKey: 'cpu',
            modelId: 'yolov9s-640',
            maxSessions: 5,
            measuredAtMs: 1,
            phase: 'device',
          },
        ]),
      ]),
      decode: new Map(),
    })
    expect(out).toEqual([
      {
        nodeId: 'n1',
        detection: null,
        decode: null,
        capacity: null,
        limitedBy: null,
        complete: false,
      },
    ])
  })

  it('keeps a measured zero as zero', () => {
    const out = nodeCapacityVerdicts({
      runs: [{ nodeId: 'n1', deviceKey: 'cpu', modelId: 'm' }],
      measured: new Map([
        measured('n1', [
          { deviceKey: 'cpu', modelId: 'm', maxSessions: 0, measuredAtMs: 1, phase: 'pipeline' },
        ]),
      ]),
      decode: new Map(),
    })
    expect(out[0]?.detection?.maxSessions).toBe(0)
    expect(out[0]?.capacity).toBe(0)
  })

  it('takes the smaller of decode and detection and names the limit', () => {
    const detection = measured('n1', [
      { deviceKey: 'cpu', modelId: 'm', maxSessions: 9, measuredAtMs: 1, phase: 'pipeline' },
    ])
    const runs = [{ nodeId: 'n1', deviceKey: 'cpu', modelId: 'm' }]
    const decodeLimited = nodeCapacityVerdicts({
      runs,
      measured: new Map([detection]),
      decode: new Map([['n1', DECODE]]),
    })
    expect(decodeLimited[0]).toMatchObject({
      capacity: 6,
      limitedBy: 'decode',
      complete: true,
      decode: DECODE,
    })
    const detectionLimited = nodeCapacityVerdicts({
      runs,
      measured: new Map([detection]),
      decode: new Map([['n1', { ...DECODE, maxStreams: 20 }]]),
    })
    expect(detectionLimited[0]).toMatchObject({
      capacity: 9,
      limitedBy: 'detection',
      complete: true,
    })
    // A tie is the detection plane's: adding decode would not raise it.
    const tie = nodeCapacityVerdicts({
      runs,
      measured: new Map([detection]),
      decode: new Map([['n1', { ...DECODE, maxStreams: 9 }]]),
    })
    expect(tie[0]).toMatchObject({ capacity: 9, limitedBy: 'detection' })
  })

  it('answers a node measured for decode only, and filters by node', () => {
    const out = nodeCapacityVerdicts({
      runs: [],
      measured: new Map([
        measured('n2', [
          { deviceKey: 'cpu', modelId: 'm', maxSessions: 2, measuredAtMs: 1, phase: 'device' },
        ]),
      ]),
      decode: new Map([['n1', DECODE]]),
    })
    expect(out.map((v) => v.nodeId)).toEqual(['n1', 'n2'])
    expect(out[0]).toMatchObject({
      detection: null,
      capacity: 6,
      limitedBy: null,
      complete: false,
    })
    const only = nodeCapacityVerdicts({
      nodeId: 'n1',
      runs: [],
      measured: new Map(),
      decode: new Map([['n1', DECODE]]),
    })
    expect(only.map((v) => v.nodeId)).toEqual(['n1'])
  })
})
