import { describe, expect, it } from 'vitest'
import type { NodeInferenceDevice } from '@camstack/types'
import { buildDeviceTableRows, deviceRowState } from '../node-device-table-model'

function device(over: Partial<NodeInferenceDevice> & { key: string }): NodeInferenceDevice {
  return {
    backend: 'openvino',
    device: 'gpu',
    format: 'openvino',
    available: true,
    presence: 'present',
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'yolov9m-320-int8',
    exclusion: null,
    ...over,
  }
}

describe('deviceRowState', () => {
  it('a device the probe answered without is ABSENT, whatever its stored enabled (D919)', () => {
    expect(
      deviceRowState(
        device({
          key: 'edgetpu:usb',
          available: false,
          presence: 'absent',
          exclusion: 'unavailable',
        }),
      ),
    ).toBe('absent')
  })

  it('an unanswered probe claims nothing', () => {
    expect(deviceRowState(device({ key: 'x', available: false, presence: 'unknown' }))).toBe(
      'unknown',
    )
  })

  it('present but unusable is unavailable; reported usable but excluded is a pool in backoff', () => {
    expect(deviceRowState(device({ key: 'a', available: false, exclusion: 'unavailable' }))).toBe(
      'unavailable',
    )
    expect(deviceRowState(device({ key: 'b', available: true, exclusion: 'unavailable' }))).toBe(
      'backoff',
    )
  })

  it('maps the remaining exclusions', () => {
    expect(deviceRowState(device({ key: 'c' }))).toBe('active')
    expect(deviceRowState(device({ key: 'd', exclusion: 'disabled' }))).toBe('disabled')
    expect(deviceRowState(device({ key: 'e', exclusion: 'cannot-host-camera-root' }))).toBe(
      'root-incapable',
    )
    expect(deviceRowState(device({ key: 'cpu', exclusion: 'accelerator-preferred' }))).toBe(
      'standby',
    )
  })
})

describe('buildDeviceTableRows', () => {
  const npu = device({ key: 'openvino:npu', maxSessions: 2 })
  const gpu = device({ key: 'openvino:gpu' })

  it('joins the effective share and the sessions running now', () => {
    const rows = buildDeviceTableRows(
      [gpu, npu],
      {
        nodeId: 'n',
        eligible: true,
        configuredPct: 50,
        effectivePct: 50,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: [
          { deviceKey: 'openvino:npu', eligible: true, configuredPct: 60, effectivePct: 60 },
          { deviceKey: 'openvino:gpu', eligible: true, configuredPct: 40, effectivePct: 40 },
        ],
      },
      {
        nodeId: 'n',
        sessionsNow: 2,
        sessionsStarted: 2,
        observedShare: null,
        peakSessions: 2,
        yieldsAway: 0,
        devices: [
          { deviceKey: 'openvino:npu', sessionsNow: 2, sessionsStarted: 2, observedShare: null },
        ],
      },
    )
    expect(rows.map((r) => [r.device.key, r.share?.effectivePct, r.sessionsNow, r.atCap])).toEqual([
      ['openvino:gpu', 40, 0, false],
      ['openvino:npu', 60, 2, true],
    ])
  })

  it('a node placement has not reported has unknown sessions, never 0', () => {
    const rows = buildDeviceTableRows([gpu], undefined, undefined)
    expect(rows[0]).toMatchObject({ share: null, sessionsNow: null, atCap: false })
  })
})
