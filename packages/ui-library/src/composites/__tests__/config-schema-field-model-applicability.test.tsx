// @vitest-environment jsdom
/**
 * D214 — a step setting that has no effect with the SELECTED model must not
 * render as a live control: the editor disables it and shows the reason, and a
 * labelmap-derived multiselect offers the MODEL's own labels.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ConfigField } from '@camstack/types'
import { ConfigSchemaField, type PipelineStepDisplayConfig } from '../pipeline-step'

function displayStep(modelId: string): PipelineStepDisplayConfig {
  return {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['person', 'vehicle', 'animal'],
    enabled: true,
    modelId,
    children: [],
    settings: {},
  }
}

const NMS_FIELD: ConfigField = {
  type: 'slider',
  key: 'nmsIouThreshold',
  label: 'NMS IoU threshold',
  min: 0.1,
  max: 0.9,
  step: 0.05,
  default: 0.45,
  showValue: true,
  modelApplicability: {
    inapplicable: {
      'frigate-yolonas': 'NMS is fused inside this model\'s "yolonas" export.',
    },
  },
}

const CLASSES_FIELD: ConfigField = {
  type: 'multiselect',
  key: 'enabledClasses',
  label: 'Species',
  options: [
    { value: 'cat', label: 'cat' },
    { value: 'dog', label: 'dog' },
  ],
  default: [],
  modelApplicability: {
    optionsByModel: {
      'my-wildlife': [
        { value: 'wolf', label: 'wolf' },
        { value: 'boar', label: 'boar' },
      ],
    },
  },
}

afterEach(cleanup)

describe('ConfigSchemaField — per-model applicability', () => {
  it('disables an inapplicable knob and shows the reason for the selected model', () => {
    render(
      <ConfigSchemaField
        field={NMS_FIELD}
        allFields={[NMS_FIELD]}
        step={displayStep('frigate-yolonas')}
        disabled={false}
        onChange={() => {}}
      />,
    )
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.disabled).toBe(true)
    expect(screen.getByText(/fused/i)).toBeTruthy()
  })

  it('keeps the knob live for a model it applies to', () => {
    render(
      <ConfigSchemaField
        field={NMS_FIELD}
        allFields={[NMS_FIELD]}
        step={displayStep('yolo26n')}
        disabled={false}
        onChange={() => {}}
      />,
    )
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.disabled).toBe(false)
    expect(screen.queryByText(/fused/i)).toBeNull()
  })

  it('offers the selected custom model its OWN labelmap on a labelmap-derived multiselect', () => {
    render(
      <ConfigSchemaField
        field={CLASSES_FIELD}
        allFields={[CLASSES_FIELD]}
        step={displayStep('my-wildlife')}
        disabled={false}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('wolf')).toBeTruthy()
    expect(screen.getByText('boar')).toBeTruthy()
    expect(screen.queryByText('cat')).toBeNull()
  })

  it('keeps catalog options for a catalog model', () => {
    render(
      <ConfigSchemaField
        field={CLASSES_FIELD}
        allFields={[CLASSES_FIELD]}
        step={displayStep('animal-classifier')}
        disabled={false}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('cat')).toBeTruthy()
    expect(screen.queryByText('wolf')).toBeNull()
  })
})
