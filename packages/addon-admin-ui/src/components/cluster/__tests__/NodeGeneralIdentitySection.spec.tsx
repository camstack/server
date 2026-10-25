/**
 * General-tab identity editors — node colour + reachable host (agent settings).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const hookCallCount = vi.hoisted(() => ({ n: 0 }))

const hostMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  variables: undefined as { agentNodeId?: string } | undefined,
  error: null,
}))

const colorMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  variables: undefined as { agentNodeId?: string } | undefined,
  error: null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

vi.mock('@camstack/types', async () => {
  const nodeColor = await vi.importActual<typeof import('@camstack/types/node-color')>(
    '@camstack/types/node-color',
  )
  return nodeColor
})

vi.mock('../../pipeline/placement-board/ReachableHostInput', () => ({
  ReachableHostInput: ({
    onCommit,
    nodeId,
  }: {
    readonly onCommit: (id: string, host: string | null) => void
    readonly nodeId: string
  }) => (
    <button type="button" aria-label="commit-host-clear" onClick={() => onCommit(nodeId, null)} />
  ),
}))

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

vi.mock('@camstack/ui-library', () => ({
  NODE_COLOR_IDS: ['node-a', 'node-b', 'node-c', 'node-d', 'node-e', 'node-f', 'node-g', 'node-h'],
  assignNodeColorId: () => 'node-a',
  nodeColorClass: (id: string) => `bg-${id}`,
  SettingRow: ({
    label,
    children,
  }: {
    readonly label: React.ReactNode
    readonly children: React.ReactNode
  }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  Button: ({
    'aria-label': ariaLabel,
    onClick,
    disabled,
    role,
    'aria-checked': ariaChecked,
    children,
  }: {
    readonly 'aria-label'?: string
    readonly onClick?: () => void
    readonly disabled?: boolean
    readonly role?: string
    readonly 'aria-checked'?: boolean
    readonly children?: React.ReactNode
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      role={role}
      aria-checked={ariaChecked}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  usePipelineOrchestratorListAgentSettings: () => ({
    data: [
      {
        nodeId: 'agent-1',
        settings: { reachableHost: '192.168.1.10', color: 'node-b' },
      },
    ],
    isLoading: false,
    isError: false,
  }),
  usePipelineOrchestratorSetAgentReachableHost: () => {
    const slot = hookCallCount.n % 2
    hookCallCount.n += 1
    return slot === 0 ? hostMutation : colorMutation
  },
}))

import { NodeGeneralIdentitySection } from '../NodeGeneralIdentitySection'

describe('NodeGeneralIdentitySection', () => {
  beforeEach(() => {
    hookCallCount.n = 0
    hostMutation.mutate.mockClear()
    colorMutation.mutate.mockClear()
    hostMutation.isPending = false
    colorMutation.isPending = false
  })

  it('shows the node colour picker on General', () => {
    render(
      <NodeGeneralIdentitySection nodeId="agent-1" detectedHosts={['192.168.1.10', 'fe80::1']} />,
    )
    expect(screen.getByRole('group', { name: /node colour/i })).toBeTruthy()
  })

  it('commits a colour change via setAgentReachableHost', async () => {
    render(<NodeGeneralIdentitySection nodeId="agent-1" detectedHosts={['192.168.1.10']} />)
    const swatch = screen.getByRole('radio', { name: /node-c/i })
    await act(async () => {
      fireEvent.click(swatch)
    })
    expect(colorMutation.mutate).toHaveBeenCalledWith({ agentNodeId: 'agent-1', color: 'node-c' })
  })

  it('commits null when reachable host is cleared', async () => {
    render(<NodeGeneralIdentitySection nodeId="agent-1" detectedHosts={['192.168.1.10']} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /commit-host-clear/i }))
    })
    expect(hostMutation.mutate).toHaveBeenCalledWith({
      agentNodeId: 'agent-1',
      reachableHost: null,
    })
  })

  it('keeps colour swatches enabled while reachable host save is pending', () => {
    hostMutation.isPending = true
    render(<NodeGeneralIdentitySection nodeId="agent-1" detectedHosts={['192.168.1.10']} />)
    expect(screen.getByRole('radio', { name: /node-c/i })).not.toBeDisabled()
  })
})
