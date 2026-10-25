import { describe, expect, it } from 'vitest'
import { acceleratorId, parseAcceleratorId, resolveStepSelection } from '../step-url-selection'

const STEPS = ['object-detection', 'face-detection', 'plate-ocr']
const ACCS = [acceleratorId('hub', 'openvino:gpu'), acceleratorId('hub', 'openvino:npu')]

describe('step URL selection (D757)', () => {
  it('round-trips an accelerator id whose device key carries a colon', () => {
    expect(acceleratorId('hub', 'openvino:npu')).toBe('hub/openvino:npu')
    expect(parseAcceleratorId('hub/openvino:npu')).toEqual({
      nodeId: 'hub',
      deviceKey: 'openvino:npu',
    })
    expect(parseAcceleratorId('MacMiniAgent.localdomain/coreml:all')?.nodeId).toBe(
      'MacMiniAgent.localdomain',
    )
    expect(parseAcceleratorId('nonsense')).toBeNull()
    expect(parseAcceleratorId('/x')).toBeNull()
  })

  it('takes what the URL names', () => {
    expect(
      resolveStepSelection(STEPS, ACCS, { step: 'plate-ocr', acc: 'hub/openvino:npu' }),
    ).toEqual({ stepId: 'plate-ocr', acceleratorId: 'hub/openvino:npu', staleStepId: null })
  })

  it('no step = the panel is closed', () => {
    expect(resolveStepSelection(STEPS, ACCS, { step: null, acc: null }).stepId).toBeNull()
  })

  it('a step with no accelerator is the STEP view — never silently the first accelerator', () => {
    expect(resolveStepSelection(STEPS, ACCS, { step: 'plate-ocr', acc: null })).toEqual({
      stepId: 'plate-ocr',
      acceleratorId: null,
      staleStepId: null,
    })
    // An accelerator the page does not show (switched off, gone) is not guessed either.
    expect(
      resolveStepSelection(STEPS, ACCS, { step: 'plate-ocr', acc: 'hub/cpu' }).acceleratorId,
    ).toBeNull()
  })

  it('a step that names nothing opens nothing AND says so — but not before the catalog arrives', () => {
    const stale = resolveStepSelection(STEPS, ACCS, { step: 'gone', acc: null })
    expect(stale.staleStepId).toBe('gone')
    expect(stale.stepId).toBeNull()
    expect(resolveStepSelection([], [], { step: 'gone', acc: null })).toEqual({
      stepId: null,
      acceleratorId: null,
      staleStepId: null,
    })
  })
})
