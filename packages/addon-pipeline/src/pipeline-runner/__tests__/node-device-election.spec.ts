/**
 * Unpinned work (a stateless step, a bench with no `deviceKey`) never lands on
 * the node's default pool when that pool is a device the election excluded
 * (#610).
 */
import type { NodeInferenceDevices } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { chooseNodeDevice, probeKeyOfEngine } from '../node-device-election.js'

type Row = NodeInferenceDevices['devices'][number]

function row(key: string, exclusion: Row['exclusion'], weight = 1): Row {
  const [backend = key, device = key] = key.split(':')
  return {
    key,
    backend,
    device,
    format: key === 'cpu' ? 'onnx' : 'openvino',
    available: true,
    enabled: exclusion !== 'disabled',
    weight,
    maxSessions: null,
    defaultModelId: 'm',
    exclusion,
  }
}

function view(
  devices: readonly Row[],
  defaultPoolExcluded?: boolean,
  reachable = true,
): NodeInferenceDevices {
  return {
    nodeId: 'hub',
    reachable,
    devices,
    ...(defaultPoolExcluded !== undefined ? { defaultPoolExcluded } : {}),
  }
}

describe('chooseNodeDevice', () => {
  it('GPU disabled + CPU off: nothing eligible, refused by name', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', 'disabled'), row('cpu', 'disabled')], true),
      'openvino:gpu',
    )
    expect(choice.kind).toBe('none-eligible')
  })

  it('GPU down + CPU on: the CPU is named explicitly, never the default pool', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', 'no-gpu-device'), row('cpu', null)], false),
      'openvino:gpu',
    )
    expect(choice).toEqual({ kind: 'device', deviceKey: 'cpu', format: 'onnx' })
  })

  it('GPU up and it is the default engine: the default keeps serving (unchanged)', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', null), row('cpu', 'accelerator-preferred')], false),
      'openvino:gpu',
    )
    expect(choice).toEqual({ kind: 'default' })
  })

  it('default engine unknown on a healthy node: the default keeps serving, never the heaviest device', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', null, 1), row('openvino:npu', null, 3)], false),
    )
    expect(choice).toEqual({ kind: 'default' })
    expect(
      chooseNodeDevice(view([row('openvino:gpu', null, 1), row('openvino:npu', null, 3)])),
    ).toEqual({ kind: 'default' })
  })

  it('default engine unknown but the orchestrator says it is excluded: the heaviest eligible device is named', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', null, 1), row('openvino:npu', null, 3)], true),
    )
    expect(choice).toMatchObject({ kind: 'device', deviceKey: 'openvino:npu' })
  })

  it('probeKeyOfEngine matches the probe key, the bare CPU included', () => {
    expect(
      probeKeyOfEngine({ runtime: 'python', backend: 'cpu', format: 'onnx', device: 'cpu' }),
    ).toBe('cpu')
    expect(
      probeKeyOfEngine({
        runtime: 'python',
        backend: 'openvino',
        format: 'openvino',
        device: 'gpu',
      }),
    ).toBe('openvino:gpu')
    expect(probeKeyOfEngine({ runtime: 'python', backend: 'onnx', format: 'onnx' })).toBe('onnx')
  })

  it('an unreadable or unreachable view changes nothing (D49)', () => {
    expect(chooseNodeDevice(null)).toEqual({ kind: 'default' })
    expect(chooseNodeDevice(view([], true, false))).toEqual({ kind: 'default' })
  })

  it('a CPU-only unconfigured node (nothing excluded as an operator or health word) keeps the default', () => {
    expect(chooseNodeDevice(view([row('cpu', 'disabled')], false))).toEqual({ kind: 'default' })
  })
})
