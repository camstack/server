/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeInferenceDevice } from '@camstack/types'
import { rootModelIdForDevice } from '../root-model-note.js'

expect.extend(jestDomMatchers)

const mockGetNodeInferenceDevices = vi.fn()

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@camstack/ui-library', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@camstack/ui-library')),
  usePipelineOrchestratorGetNodeInferenceDevices: () => mockGetNodeInferenceDevices(),
  usePipelineOrchestratorSetAgentInferenceDevices: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  usePipelineOrchestratorForgetInferenceDevice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  trpc: {
    platformProbe: {
      rescanAccelerators: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null, data: undefined }),
      },
    },
  },
}))

import { NodeInferenceDevices } from '../NodeInferenceDevices.js'

function inferenceDevice(
  over: Partial<NodeInferenceDevice> & Pick<NodeInferenceDevice, 'key'>,
): NodeInferenceDevice {
  return {
    backend: 'openvino',
    device: 'npu',
    format: 'onnx',
    available: true,
    presence: 'present',
    enabled: true,
    weight: 100,
    maxSessions: null,
    defaultModelId: 'yolo-default',
    exclusion: null,
    steps: {},
    ...over,
  } as NodeInferenceDevice
}

describe('rootModelIdForDevice', () => {
  it('prefers the object-detection step pin over defaultModelId', () => {
    expect(
      rootModelIdForDevice({
        defaultModelId: 'yolo-default',
        steps: { 'object-detection': { modelId: 'yolo-pinned' } },
      }),
    ).toBe('yolo-pinned')
  })

  it('falls back to defaultModelId when no step pin', () => {
    expect(rootModelIdForDevice({ defaultModelId: 'yolo-default', steps: {} })).toBe('yolo-default')
    expect(rootModelIdForDevice({ defaultModelId: 'yolo-default' })).toBe('yolo-default')
  })

  it('returns null when neither pin nor default is set', () => {
    expect(rootModelIdForDevice({})).toBeNull()
    expect(
      rootModelIdForDevice({
        defaultModelId: '',
        steps: { 'object-detection': { modelId: '' } },
      }),
    ).toBeNull()
  })
})

describe('NodeInferenceDevices root model note', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the root model note while the accelerator is enabled', () => {
    mockGetNodeInferenceDevices.mockReturnValue({
      data: {
        reachable: true,
        devices: [
          inferenceDevice({
            key: 'openvino:npu',
            enabled: true,
            defaultModelId: 'yolo-npu',
          }),
        ],
      },
      isLoading: false,
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <NodeInferenceDevices nodeId="hub" nodeName="Hub" isOnline sharesAutomatic />
      </QueryClientProvider>,
    )

    expect(screen.getByText(/root model/i)).toBeInTheDocument()
    expect(screen.getByText('yolo-npu')).toBeInTheDocument()
  })

  it('a device the node no longer has reads ABSENT and offers Forget instead of a switch (D919)', () => {
    mockGetNodeInferenceDevices.mockReturnValue({
      data: {
        reachable: true,
        devices: [
          inferenceDevice({
            key: 'edgetpu:usb',
            backend: 'edgetpu',
            device: 'usb',
            format: 'tflite',
            available: false,
            presence: 'absent',
            enabled: true,
            exclusion: 'unavailable',
          }),
        ],
      },
      isLoading: false,
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <NodeInferenceDevices nodeId="hub" nodeName="Hub" isOnline sharesAutomatic />
      </QueryClientProvider>,
    )

    expect(screen.getByText('absent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /forget/i })).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
