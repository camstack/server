// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceStepMatrix, type DeviceStepMatrixProps } from '../device-step-matrix'
import type { AgentColumn, CellState } from '../pipeline-matrix-shared'
import { agentColumnKey, groupAgentColumns, shouldUseSingleNode } from '../pipeline-matrix-shared'
import type { StepTreeNode } from '../step-tree'

const TREE: readonly StepTreeNode[] = [
  {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['object'],
    children: [
      {
        addonId: 'package-detection',
        addonName: 'Package Detection',
        slot: 'refiner',
        inputClasses: ['object'],
        outputClasses: ['package'],
        children: [],
      },
    ],
  },
]

const AGENTS: readonly AgentColumn[] = [
  { agentNodeId: 'n1', engineLabel: 'coreml' },
  { agentNodeId: 'n2', engineLabel: 'onnx' },
]

/** Three-node set mirroring the real cluster (hub | agent-a | mac). */
const AGENTS_3: readonly AgentColumn[] = [
  { agentNodeId: 'hub', engineLabel: 'openvino' },
  { agentNodeId: 'agent-a', engineLabel: 'onnx' },
  { agentNodeId: 'mac', engineLabel: 'coreml' },
]

function mockWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

function renderMatrix(overrides: Partial<DeviceStepMatrixProps> = {}) {
  const props: DeviceStepMatrixProps = {
    tree: TREE,
    agents: AGENTS,
    getCellState: (): CellState => ({ kind: 'enabled', modelId: 'yolo26s' }),
    onCellClick: vi.fn(),
    selectedCell: null,
    fallbackNodeId: null,
    onFallbackNodeChange: vi.fn(),
    ...overrides,
  }
  const result = render(<DeviceStepMatrix {...props} />)
  return { props, ...result }
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('DeviceStepMatrix — step headers carry no gate control (D757)', () => {
  it('carries no gate control: the step column is the step only', () => {
    mockWidth(1200)
    renderMatrix()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('button', { name: 'On' })).toBeNull()
    expect(screen.getByText('Step')).toBeTruthy()
  })
})

describe('DeviceStepMatrix — root supply (D730)', () => {
  it('shows a "root" chip on a cell the root model supplies, and only there', () => {
    mockWidth(1200)
    renderMatrix({
      getCellState: (addonId, agent): CellState =>
        addonId === 'package-detection' && agent.agentNodeId === 'n1'
          ? { kind: 'enabled', modelId: 'rfdetr-package', suppliedByRoot: 'frigate-plus' }
          : { kind: 'enabled', modelId: 'yolo26s' },
    })
    expect(screen.getAllByText('root')).toHaveLength(1)
    expect(screen.getByTitle(/Uses the root model frigate-plus/)).toBeTruthy()
  })
})

describe('DeviceStepMatrix — skip cell click', () => {
  it('lets a ⚠ skip cell be clicked to open the picker', () => {
    mockWidth(1200)
    const { props } = renderMatrix({
      getCellState: (addonId, agent): CellState =>
        addonId === 'object-detection' && agent.agentNodeId === 'n1'
          ? { kind: 'skip' }
          : { kind: 'enabled', modelId: 'yolo26s' },
    })
    const [firstSkip] = screen.getAllByText('⚠ skip')
    if (firstSkip === undefined) throw new Error('no skip cell rendered')
    fireEvent.click(firstSkip)
    expect(props.onCellClick).toHaveBeenCalledWith(
      'object-detection',
      expect.objectContaining({ agentNodeId: 'n1' }),
      expect.any(Boolean),
    )
  })
})

/** One node (n1) expanded into two enabled inference devices (C7.4). */
const AGENTS_DEV: readonly AgentColumn[] = [
  { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'npu', deviceLabel: 'Intel NPU' },
  { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'cpu', deviceLabel: 'CPU' },
]

/** One node expanded into THREE accelerators — the per-node BASE Steps matrix. */
const AGENTS_1NODE_3DEV: readonly AgentColumn[] = [
  { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'npu', deviceLabel: 'Intel NPU' },
  { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'gpu', deviceLabel: 'Intel iGPU' },
  { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'cpu', deviceLabel: 'CPU' },
]

describe('DeviceStepMatrix — per-device column expansion (C7.4)', () => {
  it('groups two device sub-columns under ONE node super-header keyed by agentColumnKey', () => {
    mockWidth(1400)
    renderMatrix({ agents: AGENTS_DEV })

    // A single node group spanning both device columns…
    const groups = groupAgentColumns(AGENTS_DEV)
    expect(groups.length).toBe(1)
    expect(groups[0]?.grouped).toBe(true)
    expect(groups[0]?.columns.map((c) => agentColumnKey(c))).toEqual(['n1::npu', 'n1::cpu'])

    // …rendered as ONE node label + a per-device sub-label for each accelerator.
    expect(screen.getAllByText('n1').length).toBeGreaterThan(0)
    expect(screen.getByText('Intel NPU')).toBeTruthy()
    expect(screen.getByText('CPU')).toBeTruthy()
  })

  it('shows each device format PER COLUMN, never one misleading node-level format subtitle', () => {
    mockWidth(1400)
    // Coral (tflite) beside two OpenVINO devices: a single node-level format
    // subtitle would render the first column's format ("tflite") as if it were
    // the whole node's engine. Each device carries its own format instead.
    const MIXED: readonly AgentColumn[] = [
      {
        agentNodeId: 'n1',
        engineLabel: 'tflite',
        deviceKey: 'coral',
        deviceLabel: 'Coral Edge TPU',
      },
      { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'gpu', deviceLabel: 'Intel iGPU' },
      { agentNodeId: 'n1', engineLabel: 'openvino', deviceKey: 'npu', deviceLabel: 'Intel NPU' },
    ]
    renderMatrix({ agents: MIXED, fallbackNodeId: 'n1' })
    // Each device's real format renders beside its label.
    expect(screen.getByText('tflite')).toBeTruthy()
    expect(screen.getByText('Coral Edge TPU')).toBeTruthy()
    // Two OpenVINO device columns → the format appears once per device, never a
    // single node-level subtitle (which would be exactly one "openvino").
    expect(screen.getAllByText('openvino').length).toBe(2)
  })

  it('passes the full AgentColumn (with deviceKey) to onCellClick per sub-column', () => {
    mockWidth(1400)
    const { props } = renderMatrix({ agents: AGENTS_DEV })
    // object-detection row renders first → its two device cells come first.
    const cells = screen.getAllByText('yolo26s')
    fireEvent.click(cells[0]!)
    expect(props.onCellClick).toHaveBeenCalledWith(
      'object-detection',
      expect.objectContaining({ agentNodeId: 'n1', deviceKey: 'npu' }),
      expect.any(Boolean),
    )
    fireEvent.click(cells[1]!)
    expect(props.onCellClick).toHaveBeenCalledWith(
      'object-detection',
      expect.objectContaining({ agentNodeId: 'n1', deviceKey: 'cpu' }),
      expect.any(Boolean),
    )
  })

  it('a plain (no-deviceKey) column stays an ungrouped single header', () => {
    mockWidth(1400)
    const { props } = renderMatrix()
    const groups = groupAgentColumns(AGENTS)
    expect(groups.every((g) => !g.grouped)).toBe(true)
    // Single-node headers carry the engine label directly (no device sub-row).
    expect(screen.getAllByText('coreml').length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText('yolo26s')[0]!)
    const call = (props.onCellClick as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[1].deviceKey).toBeUndefined()
  })
})

describe('DeviceStepMatrix — responsive A↔B switch', () => {
  it('B (narrow): shows the node selector and a single node column', () => {
    mockWidth(400)
    const { props } = renderMatrix()
    // Node selector present (agents-scoped, role=tab per node).
    expect(screen.getByRole('tablist', { name: 'Node' })).toBeTruthy()
    // Only the selected node (n1, default) column header renders — n2 is hidden.
    expect(screen.getAllByText('n1').length).toBeGreaterThan(0)
    // n2 appears ONLY as a selector tab, not as a matrix column header pair.
    const n2Tab = screen.getByRole('tab', { name: 'n2' })
    fireEvent.click(n2Tab)
    expect(props.onFallbackNodeChange).toHaveBeenCalledWith('n2')
  })

  it('A (wide): shows both node columns and no fallback selector', () => {
    mockWidth(1200)
    renderMatrix()
    expect(screen.queryByRole('tablist', { name: 'Node' })).toBeNull()
    expect(screen.getAllByText('n1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('n2').length).toBeGreaterThan(0)
  })

  it('per-node matrix (1 node, 3 device cols) on a phone: sticky step column + horizontal scroll, no dead node selector', () => {
    // The per-node BASE Steps matrix: ONE node expanded into three accelerator
    // columns. On a phone it must NOT cram all three into the viewport (illegible
    // slivers). Instead it pins a slim STICKY step column and lets the device
    // columns scroll horizontally beside it, each fully readable. No one-tab node
    // selector (only one node), and the scroll lives INSIDE the box so the page
    // body never scrolls sideways.
    mockWidth(390)
    const { container } = renderMatrix({
      agents: AGENTS_1NODE_3DEV,
      fallbackNodeId: 'n1',
    })
    // No node selector — there is only one node, so a picker would be dead chrome.
    expect(screen.queryByRole('tablist', { name: 'Node' })).toBeNull()
    // All three accelerators still render, none dropped.
    expect(screen.getByText('Intel NPU')).toBeTruthy()
    expect(screen.getByText('Intel iGPU')).toBeTruthy()
    expect(screen.getByText('CPU')).toBeTruthy()
    // The columns scroll inside a self-contained overflow-auto box (page body
    // never scrolls sideways), and the grid is a fixed-track w-max grid (never
    // the fluid w-full cram).
    expect(container.querySelector('.overflow-auto')).toBeTruthy()
    // The grid is the fixed-track w-max grid (never the old fluid `w-full` cram).
    expect(container.querySelector('.grid.w-max')).toBeTruthy()
    expect(container.querySelector('.grid.w-full')).toBeNull()
    // The step column header stays pinned left so rows scroll under it.
    const stickyHeader = container.querySelector('.sticky.left-0')
    expect(stickyHeader).toBeTruthy()
  })

  it('B (iPhone ~390px, 3 nodes): renders EXACTLY ONE node column, no bleed', () => {
    mockWidth(390)
    renderMatrix({ agents: AGENTS_3, fallbackNodeId: 'hub' })
    // Selector lists every node…
    expect(screen.getByRole('tab', { name: 'hub' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'agent-a' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'mac' })).toBeTruthy()
    // …but ONLY the selected node's column renders. The column header carries
    // the engine label; the selector tab does not — so exactly one engine
    // label proves exactly one node column (no squished second column, no
    // green sliver bleeding off the right edge).
    expect(screen.getAllByText('openvino').length).toBe(1)
    expect(screen.queryByText('onnx')).toBeNull()
    expect(screen.queryByText('coreml')).toBeNull()
  })
})

describe('shouldUseSingleNode', () => {
  it('stays wide with a single node + single column that fits', () => {
    // 1 node, 1 column (columnCount defaults to nodeCount): 600 ≥ 336 + 208 → wide.
    expect(shouldUseSingleNode(600, 1, 336)).toBe(false)
  })
  it('falls back for a single node whose device columns cannot all sit beside the sticky step column', () => {
    // Per-node BASE matrix: 1 node expanded into 3 device columns on a phone.
    // 390 < 336 (step) + 208*3 (three device cols) → fluid single-node layout,
    // so the sticky step column never occludes the accelerator columns.
    expect(shouldUseSingleNode(390, 1, 336, 208, 3)).toBe(true)
  })
  it('stays wide for a single node when all device columns fit beside the step column', () => {
    // 1 node, 2 device columns, roomy container: 1000 ≥ 336 + 208*2 = 752 → wide.
    expect(shouldUseSingleNode(1000, 1, 336, 208, 2)).toBe(false)
  })
  it('stays wide when unmeasured (width 0)', () => {
    expect(shouldUseSingleNode(0, 3, 336)).toBe(false)
  })
  it('falls back when too narrow for two node columns', () => {
    expect(shouldUseSingleNode(400, 2, 336, 208)).toBe(true)
  })
  it('falls back on a real iPhone viewport (~390px, 3 nodes)', () => {
    // 390 < 336 (step col) + 208*2 (two node cols) = 752 → single-node B.
    expect(shouldUseSingleNode(390, 3, 336, 208)).toBe(true)
  })
  it('stays wide when there is room for two node columns', () => {
    expect(shouldUseSingleNode(1000, 3, 336, 208)).toBe(false)
  })
})
