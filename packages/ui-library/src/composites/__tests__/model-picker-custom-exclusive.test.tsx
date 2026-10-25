// @vitest-environment jsdom
/**
 * Provider-first model picker: CamStack / plus catalog / plugin catalog / Custom are
 * mutually exclusive catalogs. The grouped Family→Tier selector runs INSIDE
 * the selected provider; there is no hidden "Use a custom model…" toggle.
 */

import type { PipelineAddonSchema } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelPicker } from '../model-picker'

type ModelOption = PipelineAddonSchema['models'][number]

const MODELS: readonly ModelOption[] = [
  {
    id: 'yolo26n',
    name: 'YOLO26 Nano',
    formats: { onnx: { downloaded: true, sizeMB: 10 } },
    group: { family: 'yolo26', tier: 'n', resolution: 640 },
    provider: 'camstack',
  },
  {
    id: 'yolo26s',
    name: 'YOLO26 Small',
    formats: { onnx: { downloaded: false, sizeMB: 35 } },
    group: { family: 'yolo26', tier: 's', resolution: 640 },
    provider: 'camstack',
  },
  {
    id: 'scrypted-yolov9s-relu-onnx',
    name: 'plugin catalog YOLOv9S ReLU ONNX',
    formats: { onnx: { downloaded: true, sizeMB: 20 } },
    group: { family: 'yolov9', tier: 's', resolution: 320 },
    provider: 'scrypted',
  },
  {
    id: 'frigate-yolonas',
    name: 'plus catalog YOLO-NAS',
    formats: { onnx: { downloaded: true, sizeMB: 49 } },
    provider: 'frigate',
  },
  {
    id: 'my-wildlife',
    name: 'Wildlife ONNX',
    formats: { onnx: { downloaded: true, sizeMB: 8 } },
    provider: 'custom',
  },
]

afterEach(cleanup)

describe('ModelPicker — provider-first', () => {
  it('hides the provider row when every model is CamStack', () => {
    render(
      <ModelPicker
        models={MODELS.filter((m) => m.provider === 'camstack')}
        value="yolo26n"
        onChange={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'CamStack' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'plus catalog' })).toBeNull()
    expect(screen.getByText(/— size/)).toBeTruthy()
  })

  it('shows a provider chip row when more than one provider is present', () => {
    render(<ModelPicker models={MODELS} value="yolo26n" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'CamStack' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'plus catalog' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'plugin catalog' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Custom' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /custom model/i })).toBeNull()
  })

  it("opens on the pinned model's provider and keeps CamStack families out of plugin catalog", () => {
    render(<ModelPicker models={MODELS} value="scrypted-yolov9s-relu-onnx" onChange={() => {}} />)
    // The plugin catalog family has ONE size, so it draws no size ladder (a ladder
    // with one rung is nothing to pick); the selection is the pinned model.
    expect(screen.getByText('scrypted-yolov9s-relu-onnx')).toBeTruthy()
    expect(screen.queryByText(/— size/i)).toBeNull()
    expect(screen.queryByText(/YOLO26/i)).toBeNull()
  })

  it('lists plus catalog as a flat select when those entries have no group', () => {
    render(<ModelPicker models={MODELS} value="frigate-yolonas" onChange={() => {}} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('frigate-yolonas')
    expect([...select.options].some((o) => o.value === 'yolo26n')).toBe(false)
  })

  it('puts BYO models under Custom', () => {
    render(<ModelPicker models={MODELS} value="my-wildlife" onChange={() => {}} />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('my-wildlife')
    fireEvent.click(screen.getByRole('button', { name: 'CamStack' }))
    expect(screen.getByText(/— size/)).toBeTruthy()
  })
})
