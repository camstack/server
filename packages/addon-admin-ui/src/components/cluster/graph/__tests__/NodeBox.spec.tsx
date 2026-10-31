import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ClusterGraphNode } from '../build-cluster-graph'
import { NodeBox } from '../NodeBox'
import type { NodeBoxData } from '../NodeBox'

// C1: Mock @xyflow/react so Handle renders as a no-op (no RF canvas required in unit tests).
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useUiText: () => (_key: string, fallback: string | { other: string }) =>
      typeof fallback === 'string' ? fallback : fallback.other,
    FloatingLogStream: ({
      addonId,
      agentId,
      onClose,
    }: {
      addonId?: string
      agentId: string
      onClose: () => void
    }) => (
      <div data-testid="log-stream" data-addon-id={addonId ?? ''} data-agent-id={agentId}>
        <button onClick={onClose}>close-log</button>
      </div>
    ),
    useNodesRestartAddon: () => ({
      mutateAsync: vi.fn().mockResolvedValue({ success: true }),
    }),
    formatLastSeen: (ms: number | null | undefined) =>
      ms === null || ms === undefined || ms <= 0
        ? null
        : `${String(Math.floor((Date.now() - ms) / 60000))}m ago`,
  }
})

const baseNode: ClusterGraphNode = {
  nodeId: 'hub',
  isHub: true,
  isOnline: true,
  identity: {
    name: 'hub',
    ip: '192.0.2.1',
    cpu: 15,
    mem: 40,
    platform: 'darwin',
    arch: 'arm64',
  },
  runners: [
    {
      pid: 100,
      name: 'stream-broker',
      addonId: 'addon-pipeline',
      cpu: 5,
      mem: 10 * 1024 * 1024,
      state: 'running',
      caps: [{ name: 'stream-catalog', addonId: 'addon-pipeline' }],
    },
    {
      pid: 200,
      name: 'provider-hikvision',
      addonId: 'addon-provider-hikvision',
      cpu: 3,
      mem: 8 * 1024 * 1024,
      state: 'running',
      caps: [{ name: 'ptz', addonId: 'addon-provider-hikvision' }],
    },
  ],
}

/** Helper: build NodeBoxData with expand-all signals at their initial state. */
function makeData(node: ClusterGraphNode, overrides: Partial<NodeBoxData> = {}): NodeBoxData {
  return {
    ...node,
    onOpenNodeDetail: () => {},
    expandAllValue: false,
    expandAllNonce: 0,
    ...overrides,
  }
}

const defaultProps = {
  id: 'hub',
  type: 'nodeBox',
  zIndex: 0,
  isConnectable: false,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  dragging: false,
  selected: false,
} as const

describe('NodeBox', () => {
  it('renders hub badge, node name, IP, cpu%, and mem%', () => {
    render(<NodeBox data={makeData(baseNode)} {...defaultProps} />)
    expect(screen.getByText('HUB')).toBeTruthy()
    expect(screen.getByText('hub')).toBeTruthy()
    expect(screen.getByText(/192\.0\.2\.1/)).toBeTruthy()
    expect(screen.getByText(/15%/)).toBeTruthy()
    expect(screen.getByText(/40%/)).toBeTruthy()
  })

  it('renders AGENT badge when isHub=false', () => {
    const agentNode: ClusterGraphNode = {
      ...baseNode,
      nodeId: 'agent-1',
      isHub: false,
      identity: { ...baseNode.identity, name: 'agent-1' },
    }
    render(<NodeBox data={makeData(agentNode)} {...defaultProps} id="agent-1" />)
    expect(screen.getByText('AGENT')).toBeTruthy()
  })

  it('renders one RunnerBlock per runner in the node', () => {
    render(<NodeBox data={makeData(baseNode)} {...defaultProps} />)
    expect(screen.getByText('stream-broker')).toBeTruthy()
    expect(screen.getByText('provider-hikvision')).toBeTruthy()
  })

  it('header click calls onOpenNodeDetail with nodeId', () => {
    const onOpenNodeDetail = vi.fn()
    render(<NodeBox data={makeData(baseNode, { onOpenNodeDetail })} {...defaultProps} />)
    fireEvent.click(screen.getByRole('button', { name: /open node detail/i }))
    expect(onOpenNodeDetail).toHaveBeenCalledWith('hub')
  })

  it('dims the node box when isOnline=false (m3: asserts on the specific opacity-50 class)', () => {
    const offlineNode: ClusterGraphNode = { ...baseNode, isOnline: false }
    const { container } = render(<NodeBox data={makeData(offlineNode)} {...defaultProps} />)
    // m3: match the specific class used in NodeBox so a class rename can't silently pass.
    expect(container.querySelector('.opacity-50')).not.toBeNull()
  })

  it('renders an offline badge with relative last-seen when offline', () => {
    const offlineNode: ClusterGraphNode = {
      ...baseNode,
      isOnline: false,
      lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
    }
    render(<NodeBox data={makeData(offlineNode)} {...defaultProps} />)
    // Offline badge text includes the relative last-seen ("5m ago").
    expect(screen.getByText(/offline · 5m ago/i)).toBeTruthy()
  })

  it('renders a bare offline badge when lastSeen is absent', () => {
    const offlineNode: ClusterGraphNode = { ...baseNode, isOnline: false }
    render(<NodeBox data={makeData(offlineNode)} {...defaultProps} />)
    expect(screen.getByText('offline')).toBeTruthy()
  })

  it('renders online status dot on node header', () => {
    const { container } = render(<NodeBox data={makeData(baseNode)} {...defaultProps} />)
    // Should have a success-coloured dot for online state
    expect(container.querySelector('[class*="success"]')).not.toBeNull()
  })

  // I1: Expand-all / Collapse-all wiring tests.
  it('Expand-all signal expands all runner cap lists', async () => {
    const { rerender } = render(<NodeBox data={makeData(baseNode)} {...defaultProps} />)

    // Initially caps are collapsed — cap names should not be visible.
    expect(screen.queryByText('stream-catalog')).toBeNull()
    expect(screen.queryByText('ptz')).toBeNull()

    // Fire Expand-all by updating nonce + value.
    await act(async () => {
      rerender(
        <NodeBox
          data={makeData(baseNode, { expandAllValue: true, expandAllNonce: 1 })}
          {...defaultProps}
        />,
      )
    })

    // Both runners' cap names should now be visible.
    expect(screen.getByText('stream-catalog')).toBeTruthy()
    expect(screen.getByText('ptz')).toBeTruthy()
  })

  it('Collapse-all signal collapses previously expanded runners', async () => {
    const { rerender } = render(
      <NodeBox
        data={makeData(baseNode, { expandAllValue: true, expandAllNonce: 1 })}
        {...defaultProps}
      />,
    )

    // Caps visible after expand.
    expect(screen.getByText('stream-catalog')).toBeTruthy()

    // Fire Collapse-all.
    await act(async () => {
      rerender(
        <NodeBox
          data={makeData(baseNode, { expandAllValue: false, expandAllNonce: 2 })}
          {...defaultProps}
        />,
      )
    })

    // Caps should be hidden again.
    expect(screen.queryByText('stream-catalog')).toBeNull()
    expect(screen.queryByText('ptz')).toBeNull()
  })
})
