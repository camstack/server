// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { PipelineAddonSchema, DeviceStepConfig } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'

// A grouped catalog with TWO families: yolo26 (the FIRST family — what an
// un-seeded picker wrongly defaults to) and yolov9 m@320 with a Standard+Int8
// precision axis. All models carry an openvino build so `modelsForFormat` keeps
// them for `engineFormat: 'openvino'`.
const MODELS: PipelineAddonSchema['models'] = [
  {
    id: 'yolo26n',
    name: 'YOLO26 Nano',
    group: { family: 'yolo26', tier: 'n' },
    formats: { openvino: { downloaded: true, sizeMB: 5 } },
  },
  {
    id: 'yolo26s',
    name: 'YOLO26 Small',
    group: { family: 'yolo26', tier: 's' },
    formats: { openvino: { downloaded: true, sizeMB: 12 } },
  },
  {
    id: 'yolov9m-320',
    name: 'YOLOv9 Medium @320',
    group: { family: 'yolov9', tier: 'm', resolution: 320 },
    formats: { openvino: { downloaded: true, sizeMB: 20 } },
  },
  {
    id: 'yolov9m-320-int8',
    name: 'YOLOv9 Medium @320 Int8',
    group: { family: 'yolov9', tier: 'm', resolution: 320, precision: 'int8' },
    formats: { openvino: { downloaded: true, sizeMB: 10 } },
  },
]

const ADDON: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: ['object'],
  childSlots: [],
  models: MODELS,
  defaultModelId: 'yolo26n',
  defaultConfidence: 0.5,
  configSchema: [],
}

function agentConfig(modelId?: string): DeviceStepConfig {
  return { settings: {}, ...(modelId !== undefined ? { modelId } : {}) }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentStepEditor — model picker seed (agent mode)', () => {
  it('seeds the picker from effectiveModelId when nothing is pinned (DEFECT: showed YOLO26 Nano)', () => {
    const onChange = vi.fn()
    render(
      <AgentStepEditor
        addon={ADDON}
        agentDefault={agentConfig()} // no modelId pinned
        engineFormat="openvino"
        effectiveModelId="yolov9m-320-int8"
        onChangeAgentConfig={onChange}
      />,
    )
    // The seed resolves the picker to YOLOv9 · Medium · 320 · Int8. Clicking the
    // sibling "Standard" precision therefore resolves to yolov9m-320 — proving
    // the family/tier/resolution came from the effective model, NOT the first
    // family (yolo26 / Nano) an empty seed would have defaulted to.
    fireEvent.click(screen.getByText('Standard'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'yolov9m-320' }))
  })

  it('lets an explicit pin win over effectiveModelId', () => {
    const onChange = vi.fn()
    render(
      <AgentStepEditor
        addon={ADDON}
        agentDefault={agentConfig('yolo26n')} // pinned to yolo26 family
        engineFormat="openvino"
        effectiveModelId="yolov9m-320-int8"
        onChangeAgentConfig={onChange}
      />,
    )
    // Active family is yolo26 (the pin), so its Nano/Small tiers render. Picking
    // Small resolves within yolo26, proving the pin — not the effective model —
    // seeded the active family.
    fireEvent.click(screen.getByText('Small'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'yolo26s' }))
  })
})
