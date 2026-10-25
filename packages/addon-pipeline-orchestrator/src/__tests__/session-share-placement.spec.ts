import type { RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { countRunningByNode, electNodeByShare } from '../session-share-placement.js'

function load(
  nodeId: string,
  attached = 0,
  devices: RunnerLocalLoad['devices'] = [],
): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras: attached,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices,
    hardware: { hasGpu: false },
  }
}

const weights = { hub: 20, mac: 70, 'agent-a': 10 }
const nodes = ['hub', 'agent-a', 'mac']

describe('electNodeByShare', () => {
  it('an empty cluster sends the first session to the highest share — not the alphabetical first', () => {
    const e = electNodeByShare({
      loads: nodes.map((n) => load(n)),
      eligible: nodes,
      weights,
      caps: {},
      runningByNode: new Map(),
    })
    expect(e).toMatchObject({ kind: 'elected', key: 'mac', reason: 'share' })
  })

  it('holds the parallel share: with mac at 7 of 7, the next goes to the hub', () => {
    const e = electNodeByShare({
      loads: nodes.map((n) => load(n)),
      eligible: nodes,
      weights,
      caps: {},
      runningByNode: new Map([['mac', 7]]),
    })
    expect(e).toMatchObject({ key: 'hub' })
  })

  it('yields from a node at its maxCameras cap to the free one with most spare room', () => {
    const e = electNodeByShare({
      loads: [load('mac', 2), load('hub', 1), load('agent-a', 0)],
      eligible: nodes,
      weights,
      caps: { mac: 2, hub: 10, 'agent-a': 1 },
      runningByNode: new Map(),
    })
    expect(e).toMatchObject({ key: 'hub', reason: 'yield', turnKey: 'mac', yieldReason: 'at-cap' })
  })

  it('yields from a drowning node, never onto another drowning one', () => {
    const full = [
      {
        deviceKey: 'coreml:all',
        backend: 'coreml',
        attachedCameras: 3,
        inFlight: 8,
        inFlightCap: 8,
      },
    ]
    const e = electNodeByShare({
      loads: [load('mac', 3, full), load('hub', 0, full), load('agent-a', 0)],
      eligible: nodes,
      weights,
      caps: {},
      runningByNode: new Map(),
    })
    expect(e).toMatchObject({ key: 'agent-a', reason: 'yield', yieldReason: 'saturated' })
  })

  it('never elects a node outside the eligible set', () => {
    const e = electNodeByShare({
      loads: nodes.map((n) => load(n)),
      eligible: ['hub'],
      weights,
      caps: {},
      runningByNode: new Map(),
    })
    expect(e).toMatchObject({ key: 'hub' })
  })
})

describe('countRunningByNode', () => {
  it('counts each camera once, sessions and standing cameras alike', () => {
    const m = countRunningByNode([
      { deviceId: 1, nodeId: 'mac' },
      { deviceId: 1, nodeId: 'mac' },
      { deviceId: 2, nodeId: 'hub' },
      { deviceId: 3, nodeId: 'mac' },
    ])
    expect([...m]).toEqual([
      ['mac', 2],
      ['hub', 1],
    ])
  })
})
