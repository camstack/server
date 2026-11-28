/**
 * Unpinned work (a stateless step, a bench with no `deviceKey`) never lands on
 * the node's default pool when that pool is a device the election excluded
 * (#610).
 */
import type { NodeInferenceDevices } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { chooseNodeDevice } from '../node-device-election.js'

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
    )
    expect(choice.kind).toBe('none-eligible')
  })

  it('the default-engine GPU is down while the CPU is eligible: the CPU is named, never the default pool', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', 'no-gpu-device'), row('cpu', null)], true),
    )
    expect(choice).toEqual({ kind: 'device', deviceKey: 'cpu', format: 'onnx' })
  })

  it('the default-engine device is eligible: the default keeps serving (unchanged)', () => {
    const choice = chooseNodeDevice(
      view([row('openvino:gpu', null), row('cpu', 'accelerator-preferred')], false),
    )
    expect(choice).toEqual({ kind: 'default' })
  })

  it('a healthy node (default engine not excluded, flag false or absent) never switches to its heaviest device', () => {
    const devices = [row('openvino:gpu', null, 1), row('openvino:npu', null, 3)]
    expect(chooseNodeDevice(view(devices, false))).toEqual({ kind: 'default' })
    expect(chooseNodeDevice(view(devices))).toEqual({ kind: 'default' })
  })

  it('the default engine is excluded while other devices are eligible: the heaviest eligible device is named', () => {
    const choice = chooseNodeDevice(
      view(
        [
          row('openvino:gpu', 'disabled'),
          row('openvino:npu', null, 3),
          row('edgetpu:usb', null, 1),
        ],
        true,
      ),
    )
    expect(choice).toMatchObject({ kind: 'device', deviceKey: 'openvino:npu' })
  })

  it('an unreadable or unreachable view changes nothing (D49)', () => {
    expect(chooseNodeDevice(null)).toEqual({ kind: 'default' })
    expect(chooseNodeDevice(view([], true, false))).toEqual({ kind: 'default' })
  })

  it('a CPU-only unconfigured node (nothing excluded as an operator or health word) keeps the default', () => {
    expect(chooseNodeDevice(view([row('cpu', 'disabled')], false))).toEqual({ kind: 'default' })
  })
})
