/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

// Mock every child tab to a light marker so the test exercises ONLY ClusterDetail's
// tab wiring (not the heavy load panel / placement board / graph deps).
vi.mock('../tabs/ClusterAssignmentsTab', () => ({
  ClusterAssignmentsTab: (props: Record<string, unknown>) => (
    <div data-testid="tab-assignments">props:{Object.keys(props).length}</div>
  ),
}))
vi.mock('../tabs/ClusterLoadBalancingTab', () => ({
  ClusterLoadBalancingTab: ({
    refreshToken,
    onOpenAutoTune,
  }: {
    refreshToken: number
    onOpenAutoTune: () => void
  }) => (
    <button type="button" data-testid="tab-load-balancing" onClick={onOpenAutoTune}>
      rt:{refreshToken}
    </button>
  ),
}))
vi.mock('../tabs/ClusterRolesNodesTab', () => ({
  ClusterRolesNodesTab: () => <div data-testid="tab-roles-nodes" />,
}))
vi.mock('../tabs/ClusterSettingsTab', () => ({ ClusterSettingsTab: () => <div /> }))
vi.mock('../tabs/ClusterAutoTuneTab', () => ({
  ClusterAutoTuneTab: () => <div data-testid="tab-auto-tune" />,
}))
vi.mock('../tabs/ClusterPaletteTab', () => ({
  ClusterPaletteTab: () => <div data-testid="tab-palette" />,
}))
vi.mock('../tabs/ClusterOrchestratorLogsTab', () => ({ ClusterOrchestratorLogsTab: () => <div /> }))

import { ClusterDetail } from '../ClusterDetail'

/** ClusterDetail keeps its tab in `?ctab=` — it needs a router. */
function renderAt(ui: ReactElement, url = '/system/pipeline'): void {
  render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>)
}

describe('ClusterDetail — Assignments / Load balancing / Roles (D748)', () => {
  it('exposes Load balancing and Roles, and no Balancer tab', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    expect(screen.getByRole('tab', { name: 'Assignments' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Load balancing' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Roles' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Balancer' })).not.toBeInTheDocument()
  })

  it('defaults to Assignments, rendered WITHOUT props (load moved out)', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    expect(screen.getByTestId('tab-assignments')).toHaveTextContent('props:0')
    expect(screen.queryByTestId('tab-load-balancing')).not.toBeInTheDocument()
  })

  it('switches to Load balancing, forwarding refreshToken, and links to Auto tune', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Load balancing' }))
    expect(screen.getByTestId('tab-load-balancing')).toHaveTextContent('rt:7')
    fireEvent.click(screen.getByTestId('tab-load-balancing'))
    expect(screen.getByTestId('tab-auto-tune')).toBeInTheDocument()
  })

  it('switches to Roles (?ctab=roles-nodes)', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roles' }))
    expect(screen.getByTestId('tab-roles-nodes')).toBeInTheDocument()
  })

  it('does not expose Events or Recording tabs', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    expect(screen.queryByRole('tab', { name: 'Events' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Recording' })).not.toBeInTheDocument()
  })

  it('has no Templates tab — pipeline templates are removed (D759)', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    expect(screen.queryByRole('tab', { name: 'Templates' })).not.toBeInTheDocument()
  })

  it('falls back to Assignments for a stale ?ctab=templates link', () => {
    renderAt(<ClusterDetail refreshToken={7} />, '/system/pipeline?ctab=templates')
    expect(screen.getByTestId('tab-assignments')).toBeInTheDocument()
  })

  it('exposes the Auto tune tab (D745)', () => {
    renderAt(<ClusterDetail refreshToken={7} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Auto tune' }))
    expect(screen.getByTestId('tab-auto-tune')).toBeInTheDocument()
  })

  it('opens the Palette tab (?ctab=palette)', () => {
    renderAt(<ClusterDetail refreshToken={7} />, '/system/pipeline?ctab=palette')
    expect(screen.getByTestId('tab-palette')).toBeInTheDocument()
  })
})
