import { describe, expect, it } from 'vitest'
import { pickInferenceDevice, RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const eligible = { 'openvino:gpu': 30, 'openvino:npu': 70 }
const idle = [
  { deviceKey: 'openvino:gpu', attachedCameras: 0 },
  { deviceKey: 'openvino:npu', attachedCameras: 0 },
]

describe('pickInferenceDevice — share placement (D748)', () => {
  it('an idle node sends the session to the device with the larger share, every time', () => {
    for (let i = 0; i < 3; i++) {
      const s = pickInferenceDevice({
        eligible,
        loads: idle,
        policy: 'share',
        rotation: new RoundRobinInferenceDeviceRotation(),
      })
      expect(s).toMatchObject({ kind: 'selected', deviceKey: 'openvino:npu', reason: 'share' })
    }
  })

  it('holds the device share of parallel sessions (7 on the NPU ⇒ next on the GPU)', () => {
    const s = pickInferenceDevice({
      eligible,
      policy: 'share',
      loads: [
        { deviceKey: 'openvino:gpu', attachedCameras: 2 },
        { deviceKey: 'openvino:npu', attachedCameras: 7 },
      ],
    })
    expect(s).toMatchObject({ deviceKey: 'openvino:gpu', reason: 'share' })
  })

  it('a device at its maxSessions cap yields to the free one', () => {
    const s = pickInferenceDevice({
      eligible,
      policy: 'share',
      loads: idle.map((l) => (l.deviceKey === 'openvino:npu' ? { ...l, attachedCameras: 1 } : l)),
      caps: { 'openvino:npu': 1 },
    })
    expect(s).toMatchObject({ deviceKey: 'openvino:gpu', reason: 'share' })
  })

  it('a pin still wins', () => {
    const s = pickInferenceDevice({
      eligible,
      policy: 'share',
      loads: idle,
      pinnedDeviceKey: 'openvino:gpu',
    })
    expect(s).toMatchObject({ deviceKey: 'openvino:gpu', reason: 'pin' })
  })

  it('least-loaded is unchanged: an idle tie rotates', () => {
    const rotation = new RoundRobinInferenceDeviceRotation()
    const pick = () =>
      pickInferenceDevice({ eligible: { a: 1, b: 1 }, rotation, policy: 'least-loaded' })
    expect([pick(), pick()].map((s) => (s.kind === 'selected' ? s.deviceKey : null))).toEqual([
      'a',
      'b',
    ])
  })

  it('every device capped ⇒ the default pool, named', () => {
    const s = pickInferenceDevice({
      eligible,
      policy: 'share',
      loads: idle.map((l) => ({ ...l, attachedCameras: 1 })),
      caps: { 'openvino:npu': 1, 'openvino:gpu': 1 },
    })
    expect(s).toMatchObject({ kind: 'default-pool', reason: 'all-devices-at-cap' })
  })
})
