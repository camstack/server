/// <reference types="@testing-library/jest-dom" />
/**
 * The three step-switch controls (cluster mode, node toggle, accelerator
 * toggle): what they write, what they say about the effective result and its
 * reason, that an unanswered matrix is never drawn as "off", and that a failed
 * write shows its error.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepSwitchMatrix } from '@camstack/types'

expect.extend(jestDomMatchers)

interface WriteHandlers {
  readonly onError: (e: unknown) => void
}

interface HoistedState {
  matrix: StepSwitchMatrix | undefined
  queryError: Error | undefined
  nodeHandlers: WriteHandlers | undefined
  readonly mutateCluster: ReturnType<typeof vi.fn>
  readonly mutateNode: ReturnType<typeof vi.fn>
  readonly mutateDevice: ReturnType<typeof vi.fn>
}

const h: HoistedState = vi.hoisted(() => ({
  matrix: undefined,
  queryError: undefined,
  nodeHandlers: undefined,
  mutateCluster: vi.fn(),
  mutateNode: vi.fn(),
  mutateDevice: vi.fn(),
}))

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@camstack/ui-library', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@camstack/ui-library')),
  usePipelineOrchestratorGetStepSwitches: () => ({
    data: h.matrix,
    isError: h.queryError !== undefined,
    error: h.queryError,
  }),
  usePipelineOrchestratorSetClusterStepMode: () => ({ mutate: h.mutateCluster, isPending: false }),
  usePipelineOrchestratorSetNodeStepEnabled: (handlers: WriteHandlers) => {
    h.nodeHandlers = handlers
    return { mutate: h.mutateNode, isPending: false }
  },
  usePipelineOrchestratorSetDeviceStepEnabled: () => ({
    mutate: h.mutateDevice,
    isPending: false,
  }),
}))

import { ClusterStepModesCard } from '../ClusterStepModesCard'
import { DeviceStepSwitches } from '../DeviceStepSwitches'
import { NodeStepSwitchesCard } from '../NodeStepSwitchesCard'
import { useStepSwitches, useStepSwitchWriters } from '../use-step-switches'

const MATRIX: StepSwitchMatrix = {
  steps: [
    {
      stepId: 'face-detection',
      name: 'Face detection',
      slot: 'detail',
      clusterMode: 'opt-in',
      effectiveMode: 'opt-in',
      camerasEnabling: 2,
      camerasDisabling: 0,
      nodes: [
        {
          nodeId: 'hub',
          reachable: true,
          stepEnabled: false,
          devices: [
            {
              deviceKey: 'cpu',
              format: 'onnx',
              stepEnabled: null,
              eligible: true,
              cell: { kind: 'off-node' },
            },
          ],
        },
      ],
    },
    {
      stepId: 'plate-recognition',
      name: 'Plate recognition',
      slot: 'detail',
      clusterMode: 'off',
      effectiveMode: 'off',
      camerasEnabling: 0,
      camerasDisabling: 0,
      nodes: [
        {
          nodeId: 'hub',
          reachable: true,
          stepEnabled: null,
          devices: [
            {
              deviceKey: 'cpu',
              format: 'onnx',
              stepEnabled: false,
              eligible: true,
              cell: { kind: 'off-cluster' },
            },
          ],
        },
      ],
    },
    {
      stepId: 'clip-embedding',
      name: 'Semantic embedding',
      slot: 'detail',
      clusterMode: null,
      effectiveMode: 'on',
      camerasEnabling: 0,
      camerasDisabling: 0,
      nodes: [
        {
          nodeId: 'hub',
          reachable: true,
          stepEnabled: null,
          devices: [
            {
              deviceKey: 'cpu',
              format: 'onnx',
              stepEnabled: null,
              eligible: true,
              cell: { kind: 'on' },
            },
          ],
        },
      ],
    },
  ],
}

beforeEach(() => {
  h.matrix = MATRIX
  h.queryError = undefined
  h.mutateCluster.mockReset()
  h.mutateNode.mockReset()
  h.mutateDevice.mockReset()
})

describe('NodeStepSwitchesCard', () => {
  it('shows the node switch and the level that turned the step off', () => {
    render(<NodeStepSwitchesCard nodeId="hub" />)
    const face = screen.getByRole('switch', { name: 'Run Face detection on this node' })
    expect(face).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Off on this node')).toBeInTheDocument()
  })

  it('a step the cluster holds off keeps its switch, disabled, and says who holds it', () => {
    render(<NodeStepSwitchesCard nodeId="hub" />)
    const plate = screen.getByRole('switch', { name: 'Run Plate recognition on this node' })
    expect(plate).toBeDisabled()
    expect(screen.getByText('Held off by the cluster — this switch is kept')).toBeInTheDocument()
    expect(screen.queryByText('Off for the whole cluster')).not.toBeInTheDocument()
  })

  it('writes false to turn a step off and null to return to inherit', () => {
    render(<NodeStepSwitchesCard nodeId="hub" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Run Face detection on this node' }))
    expect(h.mutateNode).toHaveBeenCalledWith({
      agentNodeId: 'hub',
      stepId: 'face-detection',
      enabled: null,
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Run Semantic embedding on this node' }))
    expect(h.mutateNode).toHaveBeenLastCalledWith({
      agentNodeId: 'hub',
      stepId: 'clip-embedding',
      enabled: false,
    })
  })

  it('an unanswered matrix is not drawn as off', () => {
    h.matrix = undefined
    render(<NodeStepSwitchesCard nodeId="hub" />)
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a failed query says so instead of listing steps', () => {
    h.matrix = undefined
    h.queryError = new Error('orchestrator down')
    render(<NodeStepSwitchesCard nodeId="hub" />)
    expect(screen.getByText('orchestrator down')).toBeInTheDocument()
  })

  it('a node the matrix does not list reads unknown, not off', () => {
    render(<NodeStepSwitchesCard nodeId="garage-nuc" />)
    expect(screen.getAllByText('Not known yet')).toHaveLength(3)
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    // No stored switch is known for it, so none is drawn (not an unchecked one).
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a failed write shows its error', () => {
    render(<NodeStepSwitchesCard nodeId="hub" />)
    act(() => h.nodeHandlers?.onError(new Error('node refused the switch')))
    expect(screen.getByText('node refused the switch')).toBeInTheDocument()
  })
})

describe('ClusterStepModesCard', () => {
  it('shows each step mode with the cameras that use it', () => {
    render(<ClusterStepModesCard />)
    expect(screen.getByText(/2 turn it on, 0 turn it off/)).toBeInTheDocument()
    expect(screen.getByText('Off everywhere: no camera can turn it on')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Cluster mode for Plate recognition' }),
    ).toHaveTextContent('Off')
  })

  it('does not draw modes while the matrix is pending', () => {
    h.matrix = undefined
    render(<ClusterStepModesCard />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('DeviceStepSwitches', () => {
  function Harness({ nodeId, deviceKey }: { nodeId: string; deviceKey: string }) {
    const view = useStepSwitches('failed')
    const writers = useStepSwitchWriters('failed')
    return (
      <DeviceStepSwitches nodeId={nodeId} deviceKey={deviceKey} view={view} writers={writers} />
    )
  }

  it('toggles a step on one accelerator; one held off above it is disabled and says who', () => {
    render(<Harness nodeId="hub" deviceKey="cpu" />)
    const plate = screen.getByRole('switch', { name: 'Run Plate recognition on this accelerator' })
    expect(plate).toBeDisabled()
    expect(screen.getByText('Held off by the cluster — this switch is kept')).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Run Face detection on this accelerator' }),
    ).toBeDisabled()
    expect(screen.getByText('Held off by the node — this switch is kept')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Run Semantic embedding on this accelerator' }),
    )
    expect(h.mutateDevice).toHaveBeenCalledWith({
      agentNodeId: 'hub',
      deviceKey: 'cpu',
      stepId: 'clip-embedding',
      enabled: false,
    })
  })
})
