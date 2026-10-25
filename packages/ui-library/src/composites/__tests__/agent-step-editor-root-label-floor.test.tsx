// @vitest-environment jsdom
/**
 * D741 — while the ROOT supplies a step's fine label, the step's
 * `minConfidence` slider is the floor on the root's detection score for that
 * label: it shows the ROOT model's default and an edit is bound to the ROOT
 * model. When the step runs its own model, the slider is that model's again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeviceStepConfig, PipelineAddonSchema, RootStepSupply } from '@camstack/types'
import { modelBindingKey } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'
import type { RootModelInfo } from '../root-model-source'

const ROOT = 'yolov9m-320-int8'
const OWN = 'animal-classifier'

const ANIMAL: PipelineAddonSchema = {
  id: 'animal-classifier',
  name: 'Animal Classifier',
  slot: 'classifier',
  inputClasses: ['animal'],
  outputClasses: ['animal-type'],
  childSlots: [],
  models: [
    { id: OWN, name: 'Animal classifier', formats: { onnx: { downloaded: true, sizeMB: 10 } } },
  ],
  defaultModelId: OWN,
  defaultConfidence: 0.5,
  configSchema: [
    {
      type: 'slider',
      key: 'minConfidence',
      label: 'Min Confidence',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
      bindsToModel: true,
      modelApplicability: { defaultByModel: { [OWN]: 0.8, [ROOT]: 0.75 } },
    },
  ],
}

const SUPPLY: RootStepSupply = {
  kind: 'label',
  stepId: 'animal-classifier',
  labelToEffect: { dog: 'dog' },
  uncovered: [],
}
const ROOT_MODEL: RootModelInfo = { modelId: ROOT, name: 'YOLOv9 M', supplies: [SUPPLY] }

function sliderValue(): number {
  const slider = screen.getByRole('slider')
  if (!(slider instanceof HTMLInputElement)) throw new Error('slider is not an input')
  return Number(slider.value)
}

function renderEditor(
  settings: Record<string, unknown>,
  onChange?: (next: DeviceStepConfig) => void,
): void {
  render(
    <AgentStepEditor
      addon={ANIMAL}
      agentDefault={{ settings }}
      engineFormat="onnx"
      effectiveModelId={OWN}
      rootModel={ROOT_MODEL}
      {...(onChange !== undefined ? { onChangeAgentConfig: onChange } : {})}
    />,
  )
}

afterEach(cleanup)

describe('AgentStepEditor — the threshold of a root-supplied label', () => {
  it('shows the ROOT model’s floor while the root supplies the step', () => {
    renderEditor({})
    expect(sliderValue()).toBe(0.75)
  })

  it('an edit is bound to the ROOT model', () => {
    const onChange = vi.fn<(next: DeviceStepConfig) => void>()
    renderEditor({}, onChange)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.6' } })
    expect(onChange.mock.calls[0]?.[0].settings?.[modelBindingKey('minConfidence')]).toBe(ROOT)
  })

  it('with the root source off, the slider is the step’s own model again', () => {
    renderEditor({ useRootModel: false })
    expect(sliderValue()).toBe(0.8)
  })
})
