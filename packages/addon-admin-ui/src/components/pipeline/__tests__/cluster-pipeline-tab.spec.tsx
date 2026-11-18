/// <reference types="@testing-library/jest-dom" />
/**
 * Cluster → Pipeline: the cluster step tree draws each switchable step's
 * cluster mode under its name, a child of an off step reads "off with" it,
 * and an unanswered catalog or matrix draws no mode.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineSchema, StepSwitchMatrix } from '@camstack/types'

expect.extend(jestDomMatchers)

interface HoistedState {
  schema: PipelineSchema | undefined
  matrix: StepSwitchMatrix | undefined
}

const h: HoistedState = vi.hoisted(() => ({ schema: undefined, matrix: undefined }))

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@camstack/ui-library', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@camstack/ui-library')),
  usePipelineExecutorGetSchema: () => ({
    data: h.schema,
    isLoading: h.schema === undefined,
    isError: false,
  }),
  usePipelineOrchestratorGetStepSwitches: () => ({ data: h.matrix, isError: false }),
  usePipelineOrchestratorSetClusterStepMode: () => ({ mutate: vi.fn(), isPending: false }),
  usePipelineOrchestratorSetNodeStepEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  usePipelineOrchestratorSetDeviceStepEnabled: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { ClusterPipelineTab } from '../tabs/ClusterPipelineTab'

type SlotId = PipelineSchema['slots'][number]['id']

const addon = (
  id: string,
  name: string,
  slot: SlotId,
  inputClasses: readonly string[],
  outputClasses: readonly string[],
) => ({
  id,
  name,
  slot,
  inputClasses,
  outputClasses,
  childSlots: [],
  models: [],
  defaultModelId: '',
  defaultConfidence: 0.5,
  configSchema: [],
})

const SCHEMA = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'gpu' },
  slots: [
    {
      id: 'cropper',
      label: 'Cropper',
      priority: 1,
      parentSlot: null,
      addons: [addon('plate-detection', 'Plate Detection', 'cropper', [], ['plate'])],
    },
    {
      id: 'classifier',
      label: 'Classifier',
      priority: 2,
      parentSlot: 'cropper',
      addons: [addon('plate-ocr', 'Plate Reader', 'classifier', ['plate'], ['plate-text'])],
    },
  ],
} satisfies PipelineSchema

const MATRIX: StepSwitchMatrix = {
  steps: [
    {
      stepId: 'plate-detection',
      name: 'Plate Detection',
      slot: 'detail',
      clusterMode: 'off',
      effectiveMode: 'off',
      camerasEnabling: 0,
      camerasDisabling: 0,
      nodes: [],
    },
  ],
}

beforeEach(() => {
  h.schema = SCHEMA
  h.matrix = MATRIX
})

describe('ClusterPipelineTab', () => {
  it('draws the cluster mode on the step and "off with" on its child', () => {
    render(<ClusterPipelineTab />)
    expect(
      screen.getByRole('combobox', { name: 'Cluster mode for Plate Detection' }),
    ).toHaveTextContent('Off')
    const child = screen.getByText('Plate Reader').closest('[role="rowheader"]')
    expect(child).not.toBeNull()
    expect(within(child as HTMLElement).getByText('Off with Plate Detection')).toBeInTheDocument()
    expect(within(child as HTMLElement).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('draws no mode and no "off with" while the matrix has not answered', () => {
    h.matrix = undefined
    render(<ClusterPipelineTab />)
    expect(screen.getByText('Plate Detection')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Off with/)).not.toBeInTheDocument()
  })

  it('draws no tree while the catalog has not answered', () => {
    h.schema = undefined
    render(<ClusterPipelineTab />)
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('names a matrix step the catalog has no row for, instead of dropping it silently', () => {
    h.matrix = {
      steps: [
        ...MATRIX.steps,
        { ...MATRIX.steps[0], stepId: 'clip-embedding', name: 'CLIP Embedding' },
      ],
    }
    render(<ClusterPipelineTab />)
    expect(screen.getByTestId('uncontrolled-steps')).toHaveTextContent('CLIP Embedding')
    expect(screen.getByTestId('uncontrolled-steps')).not.toHaveTextContent('Plate Detection')
  })

  it('draws no hint when every matrix step is in the tree', () => {
    render(<ClusterPipelineTab />)
    expect(screen.queryByTestId('uncontrolled-steps')).not.toBeInTheDocument()
  })
})
