/**
 * D786 — the operator is told, in the plan, that Auto tune skips a custom
 * model on a device (reason + warning). A camera carries no model (D927).
 */
import { describe, expect, it } from 'vitest'
import { reasonText, warningText } from '../auto-tune-view-model'

const nodeName = (id: string): string => (id === 'hub' ? 'Hub' : id)

describe('auto tune: custom pins', () => {
  it('a kept device says which custom model keeps it', () => {
    expect(
      reasonText({ kind: 'kept-custom-pin', modelId: 'custom-ft', deviceKey: 'openvino:npu' }),
    ).toBe('Custom model custom-ft is pinned on openvino:npu: Auto tune skips this device.')
  })

  it('warns about a custom-pinned device', () => {
    expect(
      warningText(
        {
          kind: 'custom-pin-kept',
          nodeId: 'hub',
          deviceKey: 'openvino:npu',
          modelId: 'custom-ft',
        },
        nodeName,
      ),
    ).toBe('Hub: custom model custom-ft pinned on openvino:npu — Auto tune skips this node device.')
  })

  it('an unreadable registry is said out loud', () => {
    expect(warningText({ kind: 'custom-registry-unreadable', error: 'timeout' }, nodeName)).toBe(
      'The custom-model registry could not be read (timeout): every pin to a model outside the measured catalog is kept.',
    )
  })
})
