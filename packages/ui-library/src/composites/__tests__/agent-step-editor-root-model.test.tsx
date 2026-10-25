// @vitest-environment jsdom
/**
 * D730 — "Use the root model (<name>)" on a step the root can supply: shown
 * only when the current root declares the step; checked hides the model
 * picker; toggling writes `useRootModel` and never touches the model; a root
 * that cannot supply the step leaves the intent visibly inactive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeviceStepConfig, PipelineAddonSchema, RootStepSupply } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'
import type { RootModelInfo } from '../root-model-source'

const ANIMAL: PipelineAddonSchema = {
  id: 'animal-classifier',
  name: 'Animal Classifier',
  slot: 'classifier',
  inputClasses: ['animal'],
  outputClasses: ['animal-type'],
  childSlots: [],
  models: [
    {
      id: 'animal-classifier',
      name: 'Animal classifier',
      formats: { onnx: { downloaded: true, sizeMB: 10 } },
    },
  ],
  defaultModelId: 'animal-classifier',
  defaultConfidence: 0.5,
  configSchema: [],
}

const ANIMAL_SUPPLY: RootStepSupply = {
  kind: 'label',
  stepId: 'animal-classifier',
  labelToEffect: { dog: 'dog', deer: 'deer' },
  uncovered: ['sheep'],
}

const PLUS_ROOT: RootModelInfo = {
  modelId: 'frigate-plus',
  name: 'plus catalog',
  supplies: [ANIMAL_SUPPLY],
}
const PLUGIN_ROOT: RootModelInfo = {
  modelId: 'plugin-catalog-root',
  name: 'plugin catalog',
  supplies: [],
}

afterEach(() => {
  cleanup()
})

function renderAgent(rootModel: RootModelInfo | undefined, base: DeviceStepConfig) {
  const onChange = vi.fn()
  render(
    <AgentStepEditor
      addon={ANIMAL}
      agentDefault={base}
      engineFormat="onnx"
      {...(rootModel !== undefined ? { rootModel } : {})}
      onChangeAgentConfig={onChange}
    />,
  )
  return onChange
}

describe('AgentStepEditor — Use the root model', () => {
  it('a root that supplies the step: the checkbox shows, checked by default, picker hidden', () => {
    renderAgent(PLUS_ROOT, { modelId: 'animal-classifier', settings: {} })
    const box = screen.getByLabelText('Use the root model (plus catalog)')
    expect((box as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('root-supplied-model')).toBeTruthy()
    expect(screen.getByText(/Not produced by this model: sheep/)).toBeTruthy()
  })

  it('unchecking writes useRootModel:false and keeps the model', () => {
    const onChange = renderAgent(PLUS_ROOT, {
      modelId: 'animal-classifier',
      settings: { enabledClasses: ['dog'] },
    })
    fireEvent.click(screen.getByLabelText('Use the root model (plus catalog)'))
    expect(onChange).toHaveBeenCalledWith({
      modelId: 'animal-classifier',
      settings: { enabledClasses: ['dog'], useRootModel: false },
    })
  })

  it('flag off: the checkbox is unchecked and the model picker is back', () => {
    renderAgent(PLUS_ROOT, { settings: { useRootModel: false } })
    expect(
      (screen.getByLabelText('Use the root model (plus catalog)') as HTMLInputElement).checked,
    ).toBe(false)
    expect(screen.queryByTestId('root-supplied-model')).toBeNull()
  })

  it('a root that cannot supply the step: no checkbox, the intent shown as inactive', () => {
    renderAgent(PLUGIN_ROOT, { settings: {} })
    expect(screen.queryByLabelText(/Use the root model/)).toBeNull()
    expect(screen.getByTestId('root-model-inactive').textContent).toMatch(
      /inactive — the current root model \(plugin catalog\) cannot supply this/,
    )
  })

  it('a step no root can supply, or no root known: nothing at all', () => {
    renderAgent(undefined, { settings: {} })
    expect(screen.queryByTestId('root-model-source')).toBeNull()
    expect(screen.queryByTestId('root-model-inactive')).toBeNull()
  })

  it('a root face from a 320 px root: inactive, and it says the input is too small', () => {
    const FACE: PipelineAddonSchema = { ...ANIMAL, id: 'face-detection', name: 'Face Detection' }
    const supply: RootStepSupply = {
      kind: 'crop',
      stepId: 'face-detection',
      rootLabels: ['face'],
      parentMacro: 'person',
      childClass: 'face',
      rootInputPx: 320,
    }
    render(
      <AgentStepEditor
        addon={FACE}
        agentDefault={{ settings: { useRootModel: true } }}
        engineFormat="onnx"
        rootModel={{ modelId: 'plus', name: 'plus catalog 320', supplies: [supply] }}
      />,
    )
    expect(screen.getByTestId('root-model-inactive').textContent).toMatch(/640 px or more/)
    expect(screen.queryByTestId('root-supplied-model')).toBeNull()
  })

  it('segmentation under a seg root: "Use the root model (<seg name>)", on by default', () => {
    const SEG: PipelineAddonSchema = { ...ANIMAL, id: 'segmentation', name: 'Segmentation' }
    const seg: RootModelInfo = {
      modelId: 'yolo26n-seg',
      name: 'YOLO26-seg Nano',
      supplies: [ANIMAL_SUPPLY, { kind: 'mask', stepId: 'segmentation' }],
    }
    render(
      <AgentStepEditor
        addon={SEG}
        agentDefault={{ modelId: 'u2netp', settings: {} }}
        engineFormat="onnx"
        rootModel={seg}
      />,
    )
    const box = screen.getByLabelText('Use the root model (YOLO26-seg Nano)')
    expect((box as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/Masks come from the root model/)).toBeTruthy()
  })

  it('segmentation under a plain root: no checkbox, the default intent shown inactive', () => {
    const SEG: PipelineAddonSchema = { ...ANIMAL, id: 'segmentation', name: 'Segmentation' }
    render(
      <AgentStepEditor
        addon={SEG}
        agentDefault={{ modelId: 'u2netp', settings: {} }}
        engineFormat="onnx"
        rootModel={{ modelId: 'yolo26n', name: 'YOLO26 Nano', supplies: [ANIMAL_SUPPLY] }}
      />,
    )
    expect(screen.queryByLabelText(/Use the root model/)).toBeNull()
    expect(screen.getByTestId('root-model-inactive').textContent).toMatch(
      /YOLO26 Nano\) cannot supply this/,
    )
  })
})
