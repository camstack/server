/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseTopology = vi.fn()
const mockUseAssignments = vi.fn()
const mockUseAgentSettings = vi.fn()

// NodeList pulls `CLUSTER_NODE_ID` from the (heavy) Pipeline page — stub it so
// the spec only mounts the list, not the whole route.
vi.mock('../../../pages/Pipeline', () => ({
  CLUSTER_NODE_ID: '__cluster__',
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
    useClusterTopology: () => mockUseTopology(),
    usePipelineOrchestratorGetPipelineAssignments: () => mockUseAssignments(),
    usePipelineOrchestratorListAgentSettings: () => mockUseAgentSettings(),
    formatLastSeen: (ms: number | null | undefined) =>
      ms === null || ms === undefined || ms <= 0
        ? null
        : `${String(Math.floor((Date.now() - ms) / 60000))}m ago`,
    // Minimal Badge stub surfacing variant + title + text so the spec can
    // query pills by their `title` and assert the success/danger variant.
    Badge: ({
      variant,
      title,
      children,
    }: {
      variant?: string
      title?: string
      children?: React.ReactNode
    }) => (
      <span data-testid="pill" data-variant={variant} title={title}>
        {children}
      </span>
    ),
  }
})

import { NodeList } from '../NodeList'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, name: string, isHub: boolean) {
  return {
    id,
    name,
    isHub,
    isOnline: true,
    cpuCores: 8,
    memoryMB: 16384,
  }
}

const NODES = [makeNode('hub', 'Hub', true), makeNode('mac', 'Mac Agent', false)]

describe('NodeList enablement pills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseTopology.mockReturnValue({ nodes: NODES, isLoading: false, isError: false })
    mockUseAssignments.mockReturnValue({ data: [] })
    // hub inherits enabled defaults; mac explicitly enables only audio.
    mockUseAgentSettings.mockReturnValue({
      data: [{ nodeId: 'mac', settings: { detect: false, audio: true } }],
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders success pills for a fully-enabled node (no decode pill — detect implies decode)', () => {
    render(<NodeList selectedNodeId="__cluster__" onSelect={vi.fn()} refreshToken={0} />)

    const pipe = screen.getByTitle('Pipeline: enabled')
    // hub is in enabledAudioNodes → one of the two "Audio: enabled" pills.
    expect(pipe).toHaveAttribute('data-variant', 'success')
    expect(pipe).toHaveTextContent('Pipe')
    expect(screen.getAllByTitle('Audio: enabled')).toHaveLength(2)
    // Decode is co-located with detection — no per-node decode pill exists.
    expect(screen.queryByText('Dec')).toBeNull()
  })

  it('renders danger Pipe + success Aud for an audio-only node', () => {
    render(<NodeList selectedNodeId="__cluster__" onSelect={vi.fn()} refreshToken={0} />)

    const pipe = screen.getByTitle('Pipeline: not enabled (agent capability)')
    expect(pipe).toHaveAttribute('data-variant', 'danger')
    // mac's Audio pill is one of the two "Audio: enabled" (success) pills.
    const audioPills = screen.getAllByTitle('Audio: enabled')
    expect(audioPills).toHaveLength(2)
    for (const pill of audioPills) expect(pill).toHaveAttribute('data-variant', 'success')
  })

  it('renders exactly two pills per node row (4 total for two nodes)', () => {
    render(<NodeList selectedNodeId="__cluster__" onSelect={vi.fn()} refreshToken={0} />)
    expect(screen.getAllByTestId('pill')).toHaveLength(4)
  })

  it('shows every node enabled by default while settings are loading', () => {
    mockUseAgentSettings.mockReturnValue({ data: undefined })
    render(<NodeList selectedNodeId="__cluster__" onSelect={vi.fn()} refreshToken={0} />)
    const pills = screen.getAllByTestId('pill')
    expect(pills).toHaveLength(4)
    expect(screen.getAllByTitle('Pipeline: enabled')).toHaveLength(2)
    expect(screen.getAllByTitle('Audio: enabled')).toHaveLength(2)
    expect(screen.queryAllByTitle('Pipeline: not enabled (agent capability)')).toHaveLength(0)
  })
})

describe('NodeList offline hints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAssignments.mockReturnValue({ data: [] })
    mockUseAgentSettings.mockReturnValue({ data: undefined })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders an offline hint with relative last-seen for a disconnected node', () => {
    const offlineNode = {
      ...makeNode('mac', 'Mac Agent', false),
      isOnline: false,
      lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
    }
    mockUseTopology.mockReturnValue({
      nodes: [makeNode('hub', 'Hub', true), offlineNode],
      isLoading: false,
      isError: false,
    })
    render(<NodeList selectedNodeId="__cluster__" onSelect={vi.fn()} refreshToken={0} />)
    expect(screen.getByText(/offline · 5m ago/i)).toBeTruthy()
  })
})
