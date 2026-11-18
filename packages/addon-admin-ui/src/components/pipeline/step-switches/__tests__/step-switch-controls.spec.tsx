/// <reference types="@testing-library/jest-dom" />
/**
 * The step-tree switch controls (cluster mode, node toggle, accelerator
 * toggle): what they write, what they say about the effective result and its
 * reason, that an unanswered matrix is never drawn as "off", that a child step
 * reads "off with <parent>", and that a failed write shows its error.
 */
import { selectOption } from '@camstack/ui-library/testing'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

import type { StepTreeNode } from '@camstack/ui-library'
import {
  ClusterStepRowAction,
  NodeStepRowAction,
  stepParents,
  StepSwitchNotices,
} from '../StepSwitchRowActions'
import { DeviceStepSwitchSection } from '../DeviceStepSwitchSection'
import { useStepSwitches, useStepSwitchWriters } from '../use-step-switches'

const leaf = (addonId: string, addonName: string): StepTreeNode => ({
  addonId,
  addonName,
  slot: 'classifier',
  inputClasses: [],
  outputClasses: [],
  children: [],
})

/** Switchable parents feed children with no switch of their own; `motion` has none at all. */
const TREE: readonly StepTreeNode[] = [
  {
    ...leaf('face-detection', 'Face detection'),
    children: [leaf('face-embedding', 'Face recognition')],
  },
  {
    ...leaf('plate-recognition', 'Plate recognition'),
    children: [leaf('plate-ocr', 'Plate reader')],
  },
  leaf('clip-embedding', 'Semantic embedding'),
  leaf('motion', 'Motion'),
]
const PARENTS = stepParents(TREE)
const ROW_IDS = [
  'face-detection',
  'face-embedding',
  'plate-recognition',
  'plate-ocr',
  'clip-embedding',
  'motion',
]

interface TreeProps {
  readonly nodeId: string
  readonly kind: 'node' | 'cluster'
}

/** Every tree row's action, as the matrix draws them (one hook, no second fetch). */
function TreeHarness({ nodeId, kind }: TreeProps) {
  const view = useStepSwitches('failed')
  const writers = useStepSwitchWriters('failed')
  return (
    <div>
      <StepSwitchNotices view={view} writers={writers} />
      {ROW_IDS.map((id) => (
        <div key={id} data-row={id}>
          {kind === 'node' ? (
            <NodeStepRowAction
              addonId={id}
              nodeId={nodeId}
              parents={PARENTS}
              view={view}
              writers={writers}
            />
          ) : (
            <ClusterStepRowAction addonId={id} parents={PARENTS} view={view} writers={writers} />
          )}
        </div>
      ))}
    </div>
  )
}

function DeviceHarness({ stepId }: { stepId: string }) {
  const view = useStepSwitches('failed')
  const writers = useStepSwitchWriters('failed')
  return (
    <DeviceStepSwitchSection
      nodeId="hub"
      deviceKey="cpu"
      stepId={stepId}
      view={view}
      writers={writers}
    />
  )
}

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

const rowOf = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (el === null) throw new Error(`no row ${id}`)
  return el
}

describe('node tree rows', () => {
  it('shows the node switch and the level that turned the step off', () => {
    render(<TreeHarness nodeId="hub" kind="node" />)
    const face = screen.getByRole('switch', { name: 'Run Face detection on this node' })
    expect(face).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Off on this node')).toBeInTheDocument()
  })

  it('a step the cluster holds off keeps its switch, disabled, and says who holds it', () => {
    render(<TreeHarness nodeId="hub" kind="node" />)
    expect(
      screen.getByRole('switch', { name: 'Run Plate recognition on this node' }),
    ).toBeDisabled()
    expect(screen.getByText('Held off by the cluster — this switch is kept')).toBeInTheDocument()
    expect(screen.queryByText('Off for the whole cluster')).not.toBeInTheDocument()
  })

  it('writes false to turn a step off and null to return to inherit', () => {
    render(<TreeHarness nodeId="hub" kind="node" />)
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

  it('a child step has no switch and reads off-with-parent while its parent is off', () => {
    render(<TreeHarness nodeId="hub" kind="node" />)
    const face = within(rowOf('face-embedding'))
    expect(face.getByText('Off with Face detection')).toBeInTheDocument()
    expect(face.queryByRole('switch')).not.toBeInTheDocument()
    expect(within(rowOf('plate-ocr')).getByText('Off with Plate recognition')).toBeInTheDocument()
    // A step with no switch row and no switchable parent draws nothing.
    expect(rowOf('motion')).toBeEmptyDOMElement()
  })

  it('a child of a step that runs draws nothing', () => {
    h.matrix = {
      steps: MATRIX.steps.map((r) =>
        r.stepId === 'face-detection'
          ? {
              ...r,
              nodes: r.nodes.map((n) => ({
                ...n,
                stepEnabled: null,
                devices: n.devices.map((d) => ({ ...d, cell: { kind: 'on' as const } })),
              })),
            }
          : r,
      ),
    }
    render(<TreeHarness nodeId="hub" kind="node" />)
    expect(rowOf('face-embedding')).toBeEmptyDOMElement()
  })

  it('an unanswered matrix is not drawn as off', () => {
    h.matrix = undefined
    render(<TreeHarness nodeId="hub" kind="node" />)
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(screen.queryByText(/Off with/)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a failed query says so instead of drawing switches', () => {
    h.matrix = undefined
    h.queryError = new Error('orchestrator down')
    render(<TreeHarness nodeId="hub" kind="node" />)
    expect(screen.getByText('orchestrator down')).toBeInTheDocument()
  })

  it('a node the matrix does not list reads unknown, not off', () => {
    render(<TreeHarness nodeId="garage-nuc" kind="node" />)
    expect(screen.getAllByText('Not known yet')).toHaveLength(3)
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('a failed write shows its error', () => {
    render(<TreeHarness nodeId="hub" kind="node" />)
    act(() => h.nodeHandlers?.onError(new Error('node refused the switch')))
    expect(screen.getByText('node refused the switch')).toBeInTheDocument()
  })
})

describe('cluster tree rows', () => {
  it('shows each step mode with the cameras that use it', () => {
    render(<TreeHarness nodeId="hub" kind="cluster" />)
    expect(screen.getByText(/2 turn it on, 0 turn it off/)).toBeInTheDocument()
    expect(screen.getByText('Off everywhere: no camera can turn it on')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Cluster mode for Plate recognition' }),
    ).toHaveTextContent('Off')
  })

  it('writes the chosen mode, and null for Default', () => {
    render(<TreeHarness nodeId="hub" kind="cluster" />)
    selectOption(
      screen.getByRole('combobox', { name: 'Cluster mode for Semantic embedding' }),
      'off',
    )
    expect(h.mutateCluster).toHaveBeenCalledWith({ stepId: 'clip-embedding', mode: 'off' })
    selectOption(screen.getByRole('combobox', { name: 'Cluster mode for Face detection' }), '')
    expect(h.mutateCluster).toHaveBeenLastCalledWith({ stepId: 'face-detection', mode: null })
  })

  it('a child of a step the cluster turns off reads off with it', () => {
    render(<TreeHarness nodeId="hub" kind="cluster" />)
    expect(within(rowOf('plate-ocr')).getByText('Off with Plate recognition')).toBeInTheDocument()
    expect(rowOf('face-embedding')).toBeEmptyDOMElement()
  })

  it('does not draw modes while the matrix is pending', () => {
    h.matrix = undefined
    render(<TreeHarness nodeId="hub" kind="cluster" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('DeviceStepSwitchSection', () => {
  it('toggles the step on the clicked accelerator and writes false', () => {
    render(<DeviceHarness stepId="clip-embedding" />)
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

  it('a step held off above the accelerator keeps its switch disabled and says who', () => {
    const { unmount } = render(<DeviceHarness stepId="plate-recognition" />)
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.getByText('Held off by the cluster — this switch is kept')).toBeInTheDocument()
    unmount()
    render(<DeviceHarness stepId="face-detection" />)
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.getByText('Held off by the node — this switch is kept')).toBeInTheDocument()
  })

  it('draws nothing for a step with no switch row or while the matrix is pending', () => {
    const { container, rerender } = render(<DeviceHarness stepId="motion" />)
    expect(container).toBeEmptyDOMElement()
    h.matrix = undefined
    rerender(<DeviceHarness stepId="clip-embedding" />)
    expect(container).toBeEmptyDOMElement()
  })
})
