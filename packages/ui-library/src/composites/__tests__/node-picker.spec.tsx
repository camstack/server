// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterNode } from '../../hooks/use-cluster-nodes'

expect.extend(jestDomMatchers)

const HUB: ClusterNode = {
  id: 'hub',
  name: 'Hub',
  shortName: 'HUB',
  isHub: true,
  isOnline: true,
  localIps: [],
  addons: [],
}

const OFFLINE_AGENT: ClusterNode = {
  id: 'agent-1',
  name: 'macmini',
  shortName: 'macmini',
  isHub: false,
  isOnline: false,
  localIps: [],
  addons: [],
}

let mockNodes: readonly ClusterNode[] = [HUB, OFFLINE_AGENT]
let mockSettingsData: readonly { readonly nodeId: string; readonly settings: object }[] = []

vi.mock('../../hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({ nodes: mockNodes, isLoading: false, isError: false }),
}))

vi.mock('../../generated/system-hooks', () => ({
  usePipelineOrchestratorListAgentSettings: () => ({
    data: mockSettingsData,
    isLoading: false,
    error: null,
  }),
}))

const { NodePicker } = await import('../node-picker')

describe('NodePicker', () => {
  beforeEach(() => {
    mockNodes = [HUB, OFFLINE_AGENT]
    mockSettingsData = []
  })

  it('disables offline nodes by default', () => {
    render(<NodePicker selectedNodeId="hub" onSelect={() => undefined} alwaysShow />)
    expect(screen.getByRole('button', { name: 'macmini' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'HUB' })).toBeEnabled()
  })

  it('allows selecting offline when allowOffline', () => {
    const onSelect = vi.fn()
    render(<NodePicker selectedNodeId="hub" onSelect={onSelect} alwaysShow allowOffline />)
    const offline = screen.getByRole('button', { name: 'macmini' })
    expect(offline).toBeEnabled()
    fireEvent.click(offline)
    expect(onSelect).toHaveBeenCalledWith('agent-1')
  })

  it('applies node colour class on pills', () => {
    mockSettingsData = [{ nodeId: 'hub', settings: { color: 'node-a' } }]
    render(<NodePicker selectedNodeId="hub" onSelect={() => undefined} alwaysShow />)
    const selected = screen.getByRole('button', { name: 'HUB' })
    expect(
      selected.className.includes('text-node-a') || selected.className.includes('bg-node-a'),
    ).toBe(true)
  })
})
