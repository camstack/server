// @vitest-environment jsdom
/**
 * TrainingBaseModelPicker — multi-select trainable bases with every placement
 * listed, plus Select-all-roots / Clear over cluster root detectors.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  TrainingBaseModelPicker,
  defaultSingleClusterRoot,
  type TrainingBaseModelRow,
} from '../TrainingBaseModelPicker'
import type { StepModelCatalog } from '../../resolve-step-default-model'
import {
  defaultSelectClusterRoots,
  mapRootDetectorPlacements,
  type RootDetectorNodeInput,
} from '../root-detector-placements'

const DETECTOR_CATALOG: StepModelCatalog & { readonly slot: 'detector' } = {
  slot: 'detector',
  defaultModelId: 'yolov9t-320',
  models: [
    { id: 'yolov9m-640', formats: { openvino: { sizeMB: 40 } } },
    { id: 'yolov9m-320', formats: { openvino: { sizeMB: 20 } } },
    { id: 'yolov9t-320', formats: { openvino: { sizeMB: 8 }, tflite: { sizeMB: 6 } } },
  ],
}

const NODES: readonly RootDetectorNodeInput[] = [
  {
    nodeId: 'hub',
    catalog: DETECTOR_CATALOG,
    devices: [
      {
        key: 'openvino:npu',
        backend: 'openvino',
        device: 'npu',
        enabled: true,
        format: 'openvino',
        defaultModelId: 'yolov9m-640',
      },
      {
        key: 'openvino:gpu',
        backend: 'openvino',
        device: 'gpu',
        enabled: true,
        format: 'openvino',
        defaultModelId: 'yolov9m-640',
        steps: { 'object-detection': { modelId: 'yolov9m-320' } },
      },
      {
        key: 'cpu',
        backend: 'cpu',
        device: 'cpu',
        enabled: false,
        format: 'openvino',
        defaultModelId: 'yolov9t-320',
      },
    ],
  },
  {
    nodeId: 'garage',
    catalog: DETECTOR_CATALOG,
    devices: [
      {
        key: 'openvino:npu',
        backend: 'openvino',
        device: 'npu',
        enabled: true,
        format: 'openvino',
        defaultModelId: 'yolov9m-640',
      },
    ],
  },
]

const MODELS: readonly TrainingBaseModelRow[] = [
  {
    modelId: 'yolov9m-640',
    label: 'YOLOv9 Medium @640',
    recommended: true,
    placements: [
      { nodeId: 'hub', deviceKey: 'openvino:npu', label: 'NPU' },
      { nodeId: 'garage', deviceKey: 'openvino:npu', label: 'NPU' },
    ],
  },
  {
    modelId: 'yolov9m-320',
    label: 'YOLOv9 Medium @320',
    placements: [{ nodeId: 'hub', deviceKey: 'openvino:gpu', label: 'iGPU' }],
  },
  {
    modelId: 'yolov9t-320',
    label: 'YOLOv9 Tiny @320',
    placements: [],
  },
]

describe('mapRootDetectorPlacements', () => {
  it('lists every enabled node · device running each root model', () => {
    const byModel = mapRootDetectorPlacements(NODES)
    expect(byModel.get('yolov9m-640')).toEqual([
      { nodeId: 'garage', deviceKey: 'openvino:npu', label: 'NPU' },
      { nodeId: 'hub', deviceKey: 'openvino:npu', label: 'NPU' },
    ])
    expect(byModel.get('yolov9m-320')).toEqual([
      { nodeId: 'hub', deviceKey: 'openvino:gpu', label: 'iGPU' },
    ])
    expect(byModel.has('yolov9t-320')).toBe(false)
  })
})

describe('defaultSelectClusterRoots', () => {
  it('keeps only trainable model ids that are cluster roots', () => {
    expect(
      defaultSelectClusterRoots(
        ['yolov9m-640', 'yolov9m-320', 'yolov9t-320'],
        ['yolov9m-640', 'custom-elsewhere'],
      ),
    ).toEqual(['yolov9m-640'])
  })
})

describe('TrainingBaseModelPicker', () => {
  it('renders every placement as node · device, and the empty copy', () => {
    render(
      <TrainingBaseModelPicker
        models={MODELS}
        clusterRootModelIds={['yolov9m-640', 'yolov9m-320']}
        value={[]}
        onChange={() => undefined}
      />,
    )

    const medium640 = screen.getByTestId('training-base-model-yolov9m-640')
    expect(within(medium640).getByText('hub · NPU')).toBeTruthy()
    expect(within(medium640).getByText('garage · NPU')).toBeTruthy()

    const medium320 = screen.getByTestId('training-base-model-yolov9m-320')
    expect(within(medium320).getByText('hub · iGPU')).toBeTruthy()

    const tiny = screen.getByTestId('training-base-model-yolov9t-320')
    expect(within(tiny).getByText('Not in use on any node')).toBeTruthy()
  })

  it('Select all roots selects every cluster root that is listed', () => {
    const onChange = vi.fn()
    render(
      <TrainingBaseModelPicker
        models={MODELS}
        clusterRootModelIds={['yolov9m-640', 'yolov9m-320', 'not-in-list']}
        value={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select all roots' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(['yolov9m-640', 'yolov9m-320'])
  })

  it('Clear empties the selection', () => {
    const onChange = vi.fn()
    render(
      <TrainingBaseModelPicker
        models={MODELS}
        clusterRootModelIds={['yolov9m-640']}
        value={['yolov9m-640', 'yolov9t-320']}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('toggles one model via its checkbox', () => {
    const onChange = vi.fn()
    render(
      <TrainingBaseModelPicker
        models={MODELS}
        clusterRootModelIds={['yolov9m-640']}
        value={['yolov9m-640']}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'YOLOv9 Medium @640' }))
    expect(onChange).toHaveBeenCalledWith([])

    fireEvent.click(screen.getByRole('checkbox', { name: 'YOLOv9 Tiny @320' }))
    expect(onChange).toHaveBeenCalledWith(['yolov9m-640', 'yolov9t-320'])
  })

  it('single mode replaces selection and Select cluster root picks one recommended root', () => {
    const onChange = vi.fn()
    render(
      <TrainingBaseModelPicker
        models={MODELS}
        clusterRootModelIds={['yolov9m-640', 'yolov9m-320']}
        value={['yolov9m-320']}
        onChange={onChange}
        multiple={false}
      />,
    )

    expect(screen.getByRole('button', { name: 'Select cluster root' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select all roots' })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: 'YOLOv9 Tiny @320' }))
    expect(onChange).toHaveBeenCalledWith(['yolov9t-320'])

    fireEvent.click(screen.getByRole('button', { name: 'Select cluster root' }))
    expect(onChange).toHaveBeenCalledWith(['yolov9m-640'])
  })
})

describe('defaultSingleClusterRoot', () => {
  it('prefers a recommended cluster root over the first root id', () => {
    expect(
      defaultSingleClusterRoot(
        ['yolov9m-640', 'yolov9m-320', 'yolov9t-320'],
        ['yolov9m-320', 'yolov9m-640'],
        MODELS,
      ),
    ).toBe('yolov9m-640')
  })
})
