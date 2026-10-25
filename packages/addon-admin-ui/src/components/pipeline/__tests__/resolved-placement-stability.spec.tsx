/// <reference types="@testing-library/jest-dom" />

/**
 * The Resolved-placement column must not BLINK.
 *
 * Measured on the live cluster (2026-08-21, 396 s window): every one of 13
 * cameras visited all THREE nodes, and 98 of 171 on-motion sessions (57%)
 * landed on a different node than the camera's previous session. Between
 * sessions the camera has no pipeline assignment at all. The old cell rendered
 * that as `—` → `hub` → `—` → `agent-a`, blanking and remounting the
 * inference-device select (whose query key is the nodeId) each time.
 *
 * The UI cannot hide a value that genuinely changes — and must not. What it can
 * do is stop presenting an EPHEMERAL session dispatch as the camera's
 * placement: the node line holds the last known placement and is annotated
 * running / idle, so the row stays readable and the select stays mounted.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const mockPipelineAssignments = vi.fn()
const mockAudioAssignments = vi.fn()
const mockNodeDevicesOptions = vi.fn()

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('../../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

vi.mock('../assignments/use-camera-metrics', () => ({
  useCameraMetricsSnapshots: () => new Map(),
}))

vi.mock('../assignments/node-color-map', () => ({
  buildColorByNodeId: () =>
    new Map([
      ['hub', 'node-a'],
      ['mac', 'node-b'],
    ]),
  colorIdForNode: (_map: ReadonlyMap<string, string>, nodeId: string) =>
    nodeId === 'hub' ? 'node-a' : 'node-b',
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  // Deep source import uses `.js` (TS ESM) — `.tsx` trips TS5097 under tsconfig.spec.
  const { RoleNodePill } = await import(
    '../../../../../ui-library/src/composites/role-node-pill.js'
  )
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    RoleNodePill,
    useDeviceManagerListAll: () => ({ data: [{ id: 101, name: 'Front Door' }] }),
    usePipelineOrchestratorGetPipelineAssignments: () => mockPipelineAssignments(),
    usePipelineOrchestratorGetAudioAssignments: () => mockAudioAssignments(),
    usePipelineOrchestratorGetCameraStatuses: () => ({ data: [] }),
    usePipelineOrchestratorListAgentSettings: () => ({ data: [] }),
    usePipelineOrchestratorAssignPipeline: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorUnassignPipeline: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorAssignAudio: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorUnassignAudio: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorGetPipelineDevicePin: () => ({ data: { deviceKey: null } }),
    usePipelineOrchestratorGetNodeInferenceDevices: (
      _input: unknown,
      options?: Record<string, unknown>,
    ) => {
      mockNodeDevicesOptions(options)
      return { data: { devices: [] } }
    },
    usePipelineOrchestratorSetPipelineDevicePin: () => ({ mutate: vi.fn(), isPending: false }),
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub', isOnline: true },
        { id: 'mac', name: 'Mac Agent', isOnline: true },
      ],
    }),
    useLiveEvent: () => undefined,
    WidgetSlot: () => null,
  }
})

import { CameraAssignmentsTable } from '../CameraAssignmentsTable'

const AUDIO_ROW = { data: [{ deviceId: 101, nodeId: 'hub', pinned: false }] }

function renderAt(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAudioAssignments.mockReturnValue(AUDIO_ROW)
})

describe('Resolved placement stability', () => {
  it('keeps the last placement on screen when the on-motion session ends', () => {
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'mac', pinned: false, reason: 'capacity' }],
    })
    const { rerender } = renderAt(<CameraAssignmentsTable />)
    expect(screen.getByTestId('resolved-placement-node')).toHaveTextContent('Mac Agent')

    // Session ends — the assignment record disappears (the row comes from the
    // camera list). The cell must NOT collapse to an em dash.
    mockPipelineAssignments.mockReturnValue({ data: [] })
    rerender(
      <MemoryRouter>
        <CameraAssignmentsTable />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('resolved-placement-node')).toHaveTextContent('Mac Agent')
    expect(screen.getByText(/idle/i)).toBeInTheDocument()
  })

  it('marks the placement running while a session holds it', () => {
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'mac', pinned: false, reason: 'capacity' }],
    })
    renderAt(<CameraAssignmentsTable />)

    expect(screen.getByText('auto · capacity')).toBeInTheDocument()
    expect(screen.queryByText(/idle/i)).toBeNull()
  })

  it('says so when the camera has never been placed, instead of a bare dash', () => {
    mockPipelineAssignments.mockReturnValue({ data: [] })
    renderAt(<CameraAssignmentsTable />)

    expect(screen.getByText(/no session yet/i)).toBeInTheDocument()
  })

  it('a rewrite with the SAME node changes no DOM node — an identical value is not a change', () => {
    // The live cause of the reported flicker: an on-motion session closes and
    // reopens on the SAME node every few seconds (median 4.0 s before D217), so
    // the assignment record is rewritten with an equal-but-fresh object. React
    // must reconcile that onto the existing element — a remount would restart
    // any transition and read as a blink even though nothing changed.
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'mac', pinned: false, reason: 'capacity' }],
    })
    const { rerender } = renderAt(<CameraAssignmentsTable />)
    const before = screen.getByTestId('resolved-placement-node')

    // Session ends, then a new session lands on the same node — two renders.
    mockPipelineAssignments.mockReturnValue({ data: [] })
    rerender(
      <MemoryRouter>
        <CameraAssignmentsTable />
      </MemoryRouter>,
    )
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'mac', pinned: false, reason: 'capacity' }],
    })
    rerender(
      <MemoryRouter>
        <CameraAssignmentsTable />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('resolved-placement-node')).toBe(before)
  })

  it('does not force a cross-node accelerator probe on every remount', () => {
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'mac', pinned: false, reason: 'capacity' }],
    })
    renderAt(<CameraAssignmentsTable />)

    // `getNodeInferenceDevices` fans out a live platform probe to the node.
    // `refetchOnMount:'always'` re-ran it every time the resolved node changed
    // — i.e. on 57% of session dispatches, from a page merely left open.
    const options = mockNodeDevicesOptions.mock.calls.at(-1)?.[0]
    expect(options?.refetchOnMount).not.toBe('always')
    expect(options?.staleTime).toBeGreaterThan(0)
  })
})
