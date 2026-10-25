// @vitest-environment jsdom
/**
 * The drawer's OPTIONS come from the shared `stepModelOptions` primitive, and an
 * un-resolvable seed must never masquerade as a selection.
 *
 * `package-detection` is an UNGROUPED two-model catalog, so `ModelPicker` falls
 * to the flat `<select>`. A `<select>` whose `value` matches no `<option>`
 * paints its FIRST option as chosen — which is how the operator saw "yolo is
 * selected and rfdetr-package is not even among the options" on 2026-08-08,
 * while rfdetr was in fact right there in the list and the seed was a model
 * (the device's elected `yolov9m-320-int8`) the package catalog never had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PipelineAddonSchema, DeviceStepConfig } from '@camstack/types'
import { AgentStepEditor } from '../agent-step-editor'

const PACKAGE_ADDON: PipelineAddonSchema = {
  id: 'package-detection',
  name: 'Package Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: ['package'],
  childSlots: [],
  models: [
    {
      id: 'yolov8n-package',
      name: 'YOLOv8 Nano — Package',
      formats: {
        onnx: { downloaded: false, sizeMB: 12 },
        openvino: { downloaded: true, sizeMB: 12 },
      },
    },
    {
      id: 'rfdetr-package',
      name: 'RF-DETR — Package',
      formats: {
        onnx: { downloaded: false, sizeMB: 115 },
        openvino: { downloaded: true, sizeMB: 58 },
      },
    },
  ],
  defaultModelId: 'rfdetr-package',
  defaultConfidence: 0.5,
  configSchema: [],
}

const noPin: DeviceStepConfig = { settings: {} }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentStepEditor — package step options', () => {
  it('offers rfdetr-package and pre-selects it from the effective seed', () => {
    render(
      <AgentStepEditor
        addon={PACKAGE_ADDON}
        agentDefault={noPin}
        engineFormat="openvino"
        effectiveModelId="rfdetr-package"
        onChangeAgentConfig={vi.fn()}
      />,
    )
    const select = screen.getByRole<HTMLSelectElement>('combobox')
    expect([...select.options].map((o) => o.getAttribute('value'))).toContain('rfdetr-package')
    expect(select.value).toBe('rfdetr-package')
  })

  it('shows NOTHING selected — not the first option — when the seed is not in this catalog', () => {
    render(
      <AgentStepEditor
        addon={PACKAGE_ADDON}
        agentDefault={noPin}
        engineFormat="openvino"
        // The device's elected object-detection model: no package build exists.
        effectiveModelId="yolov9m-320-int8"
        onChangeAgentConfig={vi.fn()}
      />,
    )
    const select = screen.getByRole<HTMLSelectElement>('combobox')
    // The regression: this used to read 'yolov8n-package' (the first option).
    expect(select.value).toBe('')
    expect(screen.getByText('— select a model —')).not.toBeNull()
  })

  /**
   * A format with no build SAYS SO.
   *
   * This used to assert an empty `<select>` — one blank option and nothing to
   * pick. The picker had since stopped rendering the control at all when the
   * catalog was empty, which left the "Model" heading above an empty space:
   * indistinguishable from a list still loading, or from a broken panel.
   *
   * The expectation is changed on purpose, not to reach green. An empty
   * dropdown invites a choice that does not exist; the absence of a build is a
   * fact about the FORMAT, and stating it is both more honest and more
   * actionable than offering a control with nothing in it (D315: absent must
   * never look like unknown).
   */
  it('says so on a format with no build (tflite / edgetpu), rather than showing an empty picker', () => {
    render(
      <AgentStepEditor
        addon={PACKAGE_ADDON}
        agentDefault={noPin}
        engineFormat="tflite"
        onChangeAgentConfig={vi.fn()}
      />,
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/No model is published for this engine format/)).not.toBeNull()
  })
})
