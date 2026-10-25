/// <reference types="@testing-library/jest-dom" />
/**
 * Task 4 — NodePipelineTab no longer mounts the Decoder Backend selector.
 *
 * The generic decoder tab (hwaccel / probe on the active decoder addon) lives
 * on NodeDetail, not here. This tab must not filter orchestrator settings to
 * `sectionIds=['decoder']`.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const panels: Array<{
  readonly addonIds?: readonly string[]
  readonly sectionIds?: readonly string[]
}> = []

vi.mock('@camstack/ui-library', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  useConfirm: () => vi.fn(),
  useClusterNodes: () => ({
    nodes: [
      {
        id: 'hub',
        name: 'Hub',
        shortName: 'HUB',
        isHub: true,
        isOnline: true,
        localIps: [],
        addons: [],
      },
    ],
    isLoading: false,
    isError: false,
  }),
  usePipelineOrchestratorResetNodePipelineDefaults: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}))

vi.mock('../CameraStatusStrip', () => ({
  CameraStatusStrip: () => <div data-testid="camera-strip" />,
}))

vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: {
    readonly addonIds?: readonly string[]
    readonly sectionIds?: readonly string[]
  }) => {
    panels.push({ addonIds: props.addonIds, sectionIds: props.sectionIds })
    return <div data-testid="addons-settings-panel" />
  },
}))

vi.mock('../step-inspector/NodeStepInspector', () => ({
  NodeStepInspector: ({ toolbar }: { toolbar?: React.ReactNode }) => (
    <div data-testid="step-inspector">{toolbar}</div>
  ),
}))

import { NodePipelineTab } from '../tabs/NodePipelineTab'

describe('NodePipelineTab', () => {
  it('does not require a decoder backend settings panel (sectionIds=["decoder"])', () => {
    panels.length = 0
    render(<NodePipelineTab nodeId="hub" refreshToken={0} />)

    expect(panels.some((panel) => panel.sectionIds?.includes('decoder'))).toBe(false)
    expect(
      panels.some(
        (panel) =>
          panel.addonIds?.includes('pipeline-orchestrator') &&
          panel.sectionIds?.includes('decoder'),
      ),
    ).toBe(false)
  })

  it('hosts the step matrix, with the node reset on its toolbar, and no accelerator card', () => {
    render(<NodePipelineTab nodeId="hub" refreshToken={0} />)
    const inspector = screen.getByTestId('step-inspector')
    expect(inspector.textContent).toMatch(/reset to default/i)
    expect(screen.queryByTestId('inference-devices')).toBeNull()
  })
})
