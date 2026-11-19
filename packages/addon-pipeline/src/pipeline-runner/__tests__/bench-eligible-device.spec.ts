/**
 * A bench with no `deviceKey` never lands on the node's default pool when that
 * pool is a device the election excluded (#610). The election itself is
 * `node-device-election.spec.ts`; this holds what the bench does with the answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { benchInputOnEligibleDevice } from '../bench-dispatch.js'
import type { NodeDeviceChoice } from '../node-device-election.js'

const asked = (choice: NodeDeviceChoice): (() => Promise<NodeDeviceChoice>) =>
  vi.fn(async () => choice)

describe('benchInputOnEligibleDevice', () => {
  it('eligible: an unpinned bench is pinned to the elected device', async () => {
    const out = await benchInputOnEligibleDevice(
      { simulatePipeline: false },
      asked({ kind: 'device', deviceKey: 'openvino:gpu', format: 'openvino' }),
      vi.fn(),
    )
    expect(out).toEqual({ simulatePipeline: false, deviceKey: 'openvino:gpu' })
  })

  it('default pool not excluded: the input is returned untouched', async () => {
    const requested = { simulatePipeline: false }
    const out = await benchInputOnEligibleDevice(requested, asked({ kind: 'default' }), vi.fn())
    expect(out).toBe(requested)
    expect(out).not.toHaveProperty('deviceKey')
  })

  it('a bench that names a device runs there and never asks the election', async () => {
    const choose = asked({ kind: 'device', deviceKey: 'openvino:npu', format: 'openvino' })
    const out = await benchInputOnEligibleDevice({ deviceKey: 'cpu' }, choose, vi.fn())
    expect(out.deviceKey).toBe('cpu')
    expect(choose).not.toHaveBeenCalled()
  })

  it('no eligible device: refused with the reason, and the refusal is logged', async () => {
    const onRefused = vi.fn()
    await expect(
      benchInputOnEligibleDevice(
        {},
        asked({ kind: 'none-eligible', detail: 'every device is off' }),
        onRefused,
      ),
    ).rejects.toThrow('no-eligible-device — every device is off')
    expect(onRefused).toHaveBeenCalledWith('every device is off')
  })
})
