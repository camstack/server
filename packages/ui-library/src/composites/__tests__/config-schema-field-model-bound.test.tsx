// @vitest-environment jsdom
/**
 * D738 — a model-bound field (the per-class confidence floors) shows the value
 * in force for the SELECTED model, says whether it is that model's default or
 * an override, writes an override together with the model it was made for,
 * and resets to the model default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ConfigField } from '@camstack/types'
import { modelBindingKey } from '@camstack/types'
import { ConfigSchemaField, type PipelineStepDisplayConfig } from '../pipeline-step'

const KEY = 'minConfidencePerson'
const V9 = 'yolov9m-320-int8'
const Y26 = 'yolo26s-320-int8'

const FLOOR: ConfigField = {
  type: 'slider',
  key: KEY,
  label: 'Min Confidence — Person',
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.65,
  showValue: true,
  bindsToModel: true,
  modelApplicability: { defaultByModel: { [Y26]: 0.45 } },
}

function displayStep(
  modelId: string,
  settings: Record<string, unknown>,
): PipelineStepDisplayConfig {
  return {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['person'],
    enabled: true,
    modelId,
    children: [],
    settings,
  }
}

function renderFloor(
  modelId: string,
  settings: Record<string, unknown>,
  onChange: (next: PipelineStepDisplayConfig) => void = () => {},
): void {
  render(
    <ConfigSchemaField
      field={FLOOR}
      allFields={[FLOOR]}
      step={displayStep(modelId, settings)}
      disabled={false}
      onChange={onChange}
    />,
  )
}

function sliderValue(): number {
  const slider = screen.getByRole('slider')
  if (!(slider instanceof HTMLInputElement)) throw new Error('slider is not an input')
  return Number(slider.value)
}

afterEach(cleanup)

describe('ConfigSchemaField — model-bound floors', () => {
  it('no override: the selected model’s default, labelled as such', () => {
    renderFloor(Y26, {})
    expect(sliderValue()).toBe(0.45)
    expect(screen.getByTestId('model-bound-source').textContent).toMatch(/model default/i)
    expect(screen.queryByRole('button', { name: /reset to model default/i })).toBeNull()
  })

  it('a model without its own default shows the global default, marked untuned', () => {
    renderFloor('my-plus-catalog-plus', {})
    expect(sliderValue()).toBe(0.65)
    expect(screen.getByTestId('model-bound-source').textContent).toMatch(/not tuned/i)
  })

  it('an override for the selected model is shown as an override, with a reset', () => {
    renderFloor(V9, { [KEY]: 0.4, [modelBindingKey(KEY)]: V9 })
    expect(sliderValue()).toBe(0.4)
    expect(screen.getByTestId('model-bound-source').textContent).toMatch(/override/i)
    expect(screen.getByRole('button', { name: /reset to model default/i })).toBeTruthy()
  })

  it('an override made for another model is NOT shown as the value', () => {
    renderFloor(Y26, { [KEY]: 0.4, [modelBindingKey(KEY)]: V9 })
    expect(sliderValue()).toBe(0.45)
    expect(screen.getByTestId('model-bound-source').textContent).toMatch(/model default/i)
    expect(screen.getByText(new RegExp(`set for ${V9}`))).toBeTruthy()
  })

  it('moving the slider writes the value bound to the selected model', () => {
    const onChange = vi.fn<(next: PipelineStepDisplayConfig) => void>()
    renderFloor(Y26, { other: 1 }, onChange)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.5' } })
    expect(onChange.mock.calls[0]?.[0].settings).toEqual({
      other: 1,
      [KEY]: 0.5,
      [modelBindingKey(KEY)]: Y26,
    })
  })

  it('reset removes the override and its binding', () => {
    const onChange = vi.fn<(next: PipelineStepDisplayConfig) => void>()
    renderFloor(V9, { [KEY]: 0.4, [modelBindingKey(KEY)]: V9, other: 1 }, onChange)
    fireEvent.click(screen.getByRole('button', { name: /reset to model default/i }))
    expect(onChange.mock.calls[0]?.[0].settings).toEqual({ other: 1 })
  })
})
