// @vitest-environment jsdom
/**
 * D738 — the step drawer offers ONE button that resets every model-bound
 * threshold in force for the row's effective model, in a single write. An
 * override stored for another model is kept (it applies again with that model).
 * Both the node editor and the camera-override editor show it, and an unpinned
 * row is judged on its EFFECTIVE model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeviceStepConfig, ConfigField, PipelineAddonSchema } from '@camstack/types'
import { modelBindingKey } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'

const V9 = 'yolov9m-320-int8'
const Y26 = 'yolo26s-320-int8'
const PERSON = 'minConfidencePerson'
const VEHICLE = 'minConfidenceVehicle'

function floor(key: string): ConfigField {
  return {
    type: 'slider',
    key,
    label: key,
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    bindsToModel: true,
  }
}

const OBJECT_DETECTION: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: ['person', 'vehicle'],
  childSlots: [],
  models: [
    { id: V9, name: 'v9', formats: { openvino: { downloaded: true, sizeMB: 20 } } },
    { id: Y26, name: 'y26', formats: { openvino: { downloaded: true, sizeMB: 10 } } },
  ],
  defaultModelId: 'yolo26n',
  defaultConfidence: 0.5,
  configSchema: [floor(PERSON), floor(VEHICLE)],
}

const RESET = /reset thresholds to model defaults/i

afterEach(cleanup)

describe('AgentStepEditor — reset thresholds to model defaults', () => {
  it('node editor: clears every override for the effective model in one change', () => {
    const onChange = vi.fn<(next: DeviceStepConfig) => void>()
    render(
      <AgentStepEditor
        addon={OBJECT_DETECTION}
        agentDefault={{
          settings: {
            [PERSON]: 0.4,
            [modelBindingKey(PERSON)]: V9,
            [VEHICLE]: 0.7,
            [modelBindingKey(VEHICLE)]: V9,
            other: 1,
          },
        }}
        engineFormat="openvino"
        effectiveModelId={V9}
        onChangeAgentConfig={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: RESET }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0].settings).toEqual({ other: 1 })
  })

  it('is not offered when nothing is overridden for the effective model', () => {
    render(
      <AgentStepEditor
        addon={OBJECT_DETECTION}
        agentDefault={{
          settings: { [PERSON]: 0.4, [modelBindingKey(PERSON)]: Y26 },
        }}
        engineFormat="openvino"
        effectiveModelId={V9}
      />,
    )
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
  })
})
