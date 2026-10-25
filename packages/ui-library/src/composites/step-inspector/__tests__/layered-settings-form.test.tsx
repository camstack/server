// @vitest-environment jsdom
/**
 * D754 — the inspector's settings form edits ONE layer of a step's settings
 * (node, camera or one accelerator), shows every field's value as it runs on
 * the viewed accelerator, says which layer it comes from, and writes a
 * FIELD-LEVEL change: only the touched field (a model-bound field as its value
 * + binding pair) lands in the edited layer — never a copy of the layers below,
 * which is how the old "Override" froze every node value into the camera.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ConfigField, PipelineAddonSchema } from '@camstack/types'
import { modelBindingKey } from '@camstack/types'
import { LayeredSettingsForm, type LayeredSettingsFormProps } from '../layered-settings-form'

const V9 = 'yolov9m-320-int8'
const PERSON = 'minConfidencePerson'
const NMS = 'nmsIouThreshold'

const FIELDS: readonly ConfigField[] = [
  {
    type: 'slider',
    key: PERSON,
    label: 'Min Confidence — Person',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.65,
    bindsToModel: true,
    modelApplicability: { defaultByModel: { [V9]: 0.78 } },
  },
  {
    type: 'slider',
    key: NMS,
    label: 'NMS IoU threshold',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.45,
  },
]

const ADDON: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: ['person'],
  childSlots: [],
  models: [{ id: V9, name: 'v9', formats: { openvino: { downloaded: true, sizeMB: 20 } } }],
  defaultModelId: V9,
  defaultConfidence: 0.5,
  configSchema: FIELDS,
}

const LABELS = { camera: 'This camera', node: 'Node' }

function renderForm(overrides: Partial<LayeredSettingsFormProps> = {}) {
  const onChangeLayer = vi.fn<(next: Record<string, unknown>) => void>()
  render(
    <LayeredSettingsForm
      addon={ADDON}
      fields={FIELDS}
      layers={{ node: { [NMS]: 0.5, motionCropDispatch: true } }}
      target="camera"
      labels={LABELS}
      modelId={V9}
      onChangeLayer={onChangeLayer}
      {...overrides}
    />,
  )
  return { onChangeLayer }
}

function fieldBox(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-field-key="${key}"]`)
  if (el === null) throw new Error(`no field ${key}`)
  return el
}

afterEach(cleanup)

describe('LayeredSettingsForm', () => {
  it('shows the value in force and names the layer that supplies it', () => {
    renderForm()
    const nms = within(fieldBox(NMS))
    expect(nms.getByTestId('setting-source').textContent).toMatch(/node/i)
    expect(nms.getByTestId('setting-levels').textContent).toMatch(/default 0\.45/)
  })

  it('a model-bound field shows the running model default when nothing stores it', () => {
    renderForm({ target: 'node', layers: { node: {} } })
    const person = within(fieldBox(PERSON))
    // Nothing stored: the running model's default (D738), labelled as such.
    expect(person.getByTestId('setting-source').textContent).toMatch(/model default/i)
  })

  it('an edit writes ONLY the touched field into the edited layer', () => {
    const { onChangeLayer } = renderForm()
    fireEvent.change(within(fieldBox(NMS)).getByRole('slider'), { target: { value: '0.6' } })
    expect(onChangeLayer).toHaveBeenLastCalledWith({ [NMS]: 0.6 })
  })

  it('a model-bound edit writes its value AND binding, nothing else', () => {
    const { onChangeLayer } = renderForm({ target: 'node', layers: { node: {} } })
    fireEvent.change(within(fieldBox(PERSON)).getByRole('slider'), { target: { value: '0.7' } })
    expect(onChangeLayer).toHaveBeenLastCalledWith({ [PERSON]: 0.7, [modelBindingKey(PERSON)]: V9 })
  })

  it('lists every level below the edited one, so node and camera can be compared', () => {
    renderForm({ layers: { node: { [NMS]: 0.5 }, camera: { [NMS]: 0.6 } } })
    const nms = within(fieldBox(NMS))
    expect(nms.getByTestId('setting-source').textContent).toMatch(/this camera/i)
    const levels = nms.getByTestId('setting-levels').textContent ?? ''
    expect(levels).toMatch(/Node 0\.5/)
    expect(levels).toMatch(/default 0\.45/)
  })

  it('a model-bound value on the node lists the running model default below it', () => {
    renderForm({
      target: 'node',
      layers: { node: { [PERSON]: 0.65, [modelBindingKey(PERSON)]: V9 } },
    })
    const person = within(fieldBox(PERSON))
    expect(person.getByTestId('setting-source').textContent).toMatch(/node/i)
    expect(person.getByTestId('setting-levels').textContent).toMatch(/model default 0\.78/)
  })

  it('never renders a model-scoped field as a camera input, even when handed one (D927)', () => {
    const modelPick: ConfigField = {
      type: 'select',
      key: 'modelId',
      label: 'Model',
      options: [{ value: V9, label: 'v9' }],
    }
    renderForm({ fields: [...FIELDS, modelPick] })
    expect(document.querySelector(`[data-field-key="${PERSON}"]`)).toBeNull()
    expect(document.querySelector('[data-field-key="modelId"]')).toBeNull()
    expect(fieldBox(NMS)).toBeTruthy()
  })

  it('reset removes the field from the edited layer only (to the next level)', () => {
    const { onChangeLayer } = renderForm({
      layers: {
        node: { [NMS]: 0.5 },
        camera: { [NMS]: 0.6, keep: true },
      },
    })
    const reset = within(fieldBox(NMS)).getByRole('button', { name: /reset to node/i })
    fireEvent.click(reset)
    expect(onChangeLayer).toHaveBeenLastCalledWith({ keep: true })
  })

  it('offers no reset on a field the edited layer does not store', () => {
    renderForm()
    expect(within(fieldBox(NMS)).queryByRole('button', { name: /reset/i })).toBeNull()
  })

  it('marks a value stored for another model as not in force here', () => {
    renderForm({
      target: 'node',
      layers: { node: { [PERSON]: 0.9, [modelBindingKey(PERSON)]: 'yolo26s-320-int8' } },
    })
    expect(within(fieldBox(PERSON)).getByTestId('setting-source').textContent).toMatch(
      /model default/i,
    )
    expect(fieldBox(PERSON).textContent).toMatch(/set for yolo26s-320-int8/i)
  })

  it('flags a legacy full-copy field pinned at the value below', () => {
    renderForm({
      target: 'camera',
      layers: { node: { [NMS]: 0.5 }, camera: { [NMS]: 0.5 } },
      pinnedKeys: [NMS],
    })
    expect(within(fieldBox(NMS)).getByText(/pinned at the node value/i)).toBeTruthy()
  })

  it('renders a per-field action', () => {
    renderForm({
      target: 'node',
      fieldActions: (key) => (key === NMS ? <button type="button">Apply to all</button> : null),
    })
    expect(within(fieldBox(NMS)).getByRole('button', { name: 'Apply to all' })).toBeTruthy()
    expect(within(fieldBox(PERSON)).queryByRole('button', { name: 'Apply to all' })).toBeNull()
  })
})
