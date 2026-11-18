import { describe, expect, it } from 'vitest'
import type { StepSwitchCell } from '@camstack/types'
import {
  cellEffect,
  deviceStepRows,
  deviceSwitchedOffCount,
  nodeEffect,
  type StepSwitchDevice,
  type StepSwitchNode,
  type StepSwitchRow,
} from '../step-switches-model'

function device(
  deviceKey: string,
  cell: StepSwitchCell,
  stepEnabled: boolean | null = null,
): StepSwitchDevice {
  return { deviceKey, format: 'onnx', stepEnabled, eligible: true, cell }
}

function node(devices: readonly StepSwitchDevice[], reachable = true): StepSwitchNode {
  return { nodeId: 'hub', reachable, stepEnabled: null, devices }
}

function row(stepId: string, devices: readonly StepSwitchDevice[]): StepSwitchRow {
  return {
    stepId,
    name: stepId,
    slot: 'detail',
    clusterMode: null,
    effectiveMode: 'on',
    camerasEnabling: 0,
    camerasDisabling: 0,
    nodes: [node(devices)],
  }
}

describe('step switch model', () => {
  it('names the level that turned a cell off', () => {
    expect(cellEffect({ kind: 'off-cluster' })).toEqual({ state: 'off', level: 'cluster' })
    expect(cellEffect({ kind: 'off-node' })).toEqual({ state: 'off', level: 'node' })
    expect(cellEffect({ kind: 'off-device' })).toEqual({ state: 'off', level: 'device' })
    expect(cellEffect({ kind: 'opt-in-unused' })).toEqual({ state: 'off', level: 'opt-in' })
    expect(cellEffect({ kind: 'skip', reason: 'no-compatible-model' })).toEqual({
      state: 'off',
      level: 'model',
    })
  })

  it('treats a jump as running, on the sibling device', () => {
    expect(cellEffect({ kind: 'jump', toDeviceKey: 'cpu' })).toEqual({
      state: 'on',
      via: 'jump',
      toDeviceKey: 'cpu',
    })
  })

  it('a node runs a step when any device does', () => {
    const effect = nodeEffect(
      node([device('a', { kind: 'off-device' }), device('b', { kind: 'on' })]),
    )
    expect(effect).toEqual({ state: 'on', via: 'direct' })
  })

  it('a node that is off everywhere reports the highest-precedence level', () => {
    const effect = nodeEffect(
      node([device('a', { kind: 'off-device' }), device('b', { kind: 'off-node' })]),
    )
    expect(effect).toEqual({ state: 'off', level: 'node' })
  })

  it('an unreachable node, or one with no device, is unknown — never off', () => {
    expect(nodeEffect(node([device('a', { kind: 'off-cluster' })], false))).toEqual({
      state: 'unknown',
    })
    expect(nodeEffect(node([]))).toEqual({ state: 'unknown' })
  })

  it('collects one accelerator across steps and counts its own switch', () => {
    const rows: readonly StepSwitchRow[] = [
      row('object-detection', [device('cpu', { kind: 'on' })]),
      row('face-detection', [device('cpu', { kind: 'off-device' }, false)]),
    ]
    const found = deviceStepRows(rows, 'hub', 'cpu')
    expect(found.map((r) => r.stepId)).toEqual(['object-detection', 'face-detection'])
    expect(deviceSwitchedOffCount(found)).toBe(1)
    expect(deviceStepRows(rows, 'hub', 'missing')).toEqual([])
  })
})
