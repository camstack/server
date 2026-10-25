/// <reference types="@testing-library/jest-dom" />
/**
 * Cluster → Assignments and node → Assignments.
 *
 *   - Rows come from the CAMERA LIST: a camera without an assignment record
 *     (no session yet, not pinned) is a row, not a missing one (audit B3).
 *   - A node is shown by its NAME everywhere in the table, never its id.
 *   - One placement column: the node pin and the device pin, both library
 *     selects; there is no second device-pin editor elsewhere in the row.
 *   - The node page lists only cameras CURRENTLY placed there, and shows the
 *     roles it holds as labels, not as checkbox look-alikes.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const mockAssignPipeline = vi.fn()
const mockUnassignPipeline = vi.fn()
const mockPipelineAssignments = vi.fn()
const mockCameraStatuses = vi.fn()
const mockDevicePin = vi.fn()
const mockNodeDevices = vi.fn()
const mockSetDevicePin = vi.fn()

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('../../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

vi.mock('../assignments/node-color-map', () => ({
  buildColorByNodeId: () =>
    new Map([
      ['hub', 'node-a'],
      ['MacMiniAgent.localdomain', 'node-b'],
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
    // The real table, selects, badges and the ONE accelerator naming rule.
    ...(await importOriginal<Record<string, unknown>>()),
    RoleNodePill,
    useDeviceManagerListAll: () => ({
      data: [
        { id: 101, name: 'Front Door' },
        { id: 102, name: 'Garden' },
        { id: 103, name: 'Camera hallway primo piano lato scale' },
      ],
    }),
    usePipelineOrchestratorGetPipelineAssignments: () => mockPipelineAssignments(),
    usePipelineOrchestratorGetAudioAssignments: () => ({ data: [] }),
    usePipelineOrchestratorGetCameraStatuses: () => mockCameraStatuses(),
    usePipelineOrchestratorListAgentSettings: () => ({ data: [] }),
    usePipelineOrchestratorAssignPipeline: () => ({ mutate: mockAssignPipeline, isPending: false }),
    usePipelineOrchestratorUnassignPipeline: () => ({
      mutate: mockUnassignPipeline,
      isPending: false,
    }),
    usePipelineOrchestratorAssignAudio: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorUnassignAudio: () => ({ mutate: vi.fn(), isPending: false }),
    usePipelineOrchestratorGetPipelineDevicePin: () =>
      mockDevicePin() ?? { data: { deviceKey: null } },
    usePipelineOrchestratorGetNodeInferenceDevices: () =>
      mockNodeDevices() ?? { data: { devices: [] } },
    usePipelineOrchestratorSetPipelineDevicePin: () => ({
      mutate: mockSetDevicePin,
      isPending: false,
    }),
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub', isOnline: true },
        { id: 'MacMiniAgent.localdomain', name: 'macmini', isOnline: true },
      ],
    }),
    useLiveEvent: () => undefined,
    WidgetSlot: () => null,
  }
})

import { CameraAssignmentsTable } from '../CameraAssignmentsTable'
import { NodeCameraAssignmentsTable } from '../NodeCameraAssignmentsTable'

function renderWithRouter(ui: ReactElement): ReturnType<typeof render> {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

const MAC = 'MacMiniAgent.localdomain'

/** Minimal CameraStatus stub — only the fields the table reads. */
function cameraStatus(
  deviceId: number,
  assignment: {
    detectionNodeId: string | null
    decoderNodeId: string | null
    audioNodeId: string | null
    pinnedDetection?: boolean
  },
) {
  return {
    deviceId,
    assignment: {
      detectionNodeId: assignment.detectionNodeId,
      decoderNodeId: assignment.decoderNodeId,
      audioNodeId: assignment.audioNodeId,
      sourceNodeId: null,
      pinned: { detection: assignment.pinnedDetection ?? false, decoder: false, audio: false },
      reasons: {},
    },
  }
}

function rowOf(name: string): HTMLElement {
  const cell = screen.getByTitle(name)
  const row = cell.closest('tr')
  if (row === null) throw new Error(`no row for ${name}`)
  return row
}

const CORAL = {
  key: 'edgetpu:usb',
  backend: 'edgetpu',
  device: 'usb',
  format: 'tflite',
  enabled: true,
}

describe('CameraAssignmentsTable (cluster)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCameraStatuses.mockReturnValue({ data: [] })
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: MAC, pinned: false, reason: 'capacity' }],
    })
  })

  it('links the camera name to the device page', () => {
    renderWithRouter(<CameraAssignmentsTable />)
    const link = screen.getByRole('link', { name: 'Front Door' })
    expect(link.getAttribute('href')).toBe('/devices/101')
  })

  it('lists every camera of the camera list, including one with no assignment record', () => {
    renderWithRouter(<CameraAssignmentsTable />)
    expect(rowOf('Front Door')).toBeInTheDocument()
    // No record: still a row, saying so.
    expect(within(rowOf('Garden')).getByText(/no session yet/i)).toBeInTheDocument()
  })

  it('names the resolved node by its display name, never its id', () => {
    renderWithRouter(<CameraAssignmentsTable />)
    const row = rowOf('Front Door')
    expect(within(row).getAllByText('macmini').length).toBeGreaterThan(0)
    expect(within(row).queryByText(MAC)).toBeNull()
    expect(row.textContent ?? '').not.toContain(MAC)
  })

  it('a long camera name is truncated with the full name as its tooltip', () => {
    renderWithRouter(<CameraAssignmentsTable />)
    const name = screen.getByTitle('Camera hallway primo piano lato scale')
    expect(name.className).toMatch(/truncate/)
  })

  it('pins a camera to a node, named in the option, and returns it to Auto', () => {
    renderWithRouter(<CameraAssignmentsTable />)
    const select = within(rowOf('Garden')).getByLabelText('Node pin') as HTMLSelectElement
    expect(within(select).getByRole('option', { name: 'Pin → macmini' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: MAC } })
    expect(mockAssignPipeline).toHaveBeenCalledWith({ deviceId: 102, agentNodeId: MAC })
  })

  it('returns a pinned camera to auto placement', () => {
    mockPipelineAssignments.mockReturnValue({
      data: [{ deviceId: 101, agentNodeId: 'hub', pinned: true, reason: 'manual' }],
    })
    renderWithRouter(<CameraAssignmentsTable />)
    const select = within(rowOf('Front Door')).getByLabelText('Node pin') as HTMLSelectElement
    expect(select.value).toBe('hub')
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(mockUnassignPipeline).toHaveBeenCalledWith({ deviceId: 101 })
  })

  it('the device pin lists Auto + enabled accelerators by name and writes the pin', () => {
    mockDevicePin.mockReturnValue({ data: { deviceKey: null } })
    mockNodeDevices.mockReturnValue({
      data: {
        devices: [
          CORAL,
          { key: 'cpu', backend: 'cpu', device: 'cpu', format: 'onnx', enabled: false },
        ],
      },
    })
    renderWithRouter(<CameraAssignmentsTable />)
    const select = within(rowOf('Front Door')).getByLabelText(
      'Inference device pin',
    ) as HTMLSelectElement
    expect(select.value).toBe('auto')
    expect(within(select).getByRole('option', { name: 'Coral Edge TPU · tflite' })).toBeTruthy()
    expect(within(select).queryByRole('option', { name: /CPU/ })).toBeNull()
    fireEvent.change(select, { target: { value: 'edgetpu:usb' } })
    expect(mockSetDevicePin).toHaveBeenCalledWith({ deviceId: 101, deviceKey: 'edgetpu:usb' })
  })

  it('a pin to an accelerator that is no longer enabled stays visible and selected', () => {
    mockDevicePin.mockReturnValue({ data: { deviceKey: 'openvino:npu' } })
    mockNodeDevices.mockReturnValue({ data: { devices: [] } })
    renderWithRouter(<CameraAssignmentsTable />)
    const select = within(rowOf('Front Door')).getByLabelText(
      'Inference device pin',
    ) as HTMLSelectElement
    expect(select.value).toBe('openvino:npu')
    expect(
      within(select).getByRole('option', { name: /openvino:npu \(not enabled\)/ }),
    ).toBeTruthy()
  })

  it('has exactly one device-pin editor per placed camera — no duplicate elsewhere in the row', () => {
    mockDevicePin.mockReturnValue({ data: { deviceKey: null } })
    mockNodeDevices.mockReturnValue({ data: { devices: [CORAL] } })
    renderWithRouter(<CameraAssignmentsTable />)
    expect(within(rowOf('Front Door')).getAllByLabelText('Inference device pin')).toHaveLength(1)
    // A camera that never ran anywhere has no node to pin a device on.
    expect(within(rowOf('Garden')).queryByLabelText('Inference device pin')).toBeNull()
  })
})

describe('NodeCameraAssignmentsTable (node page)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Persisted records deliberately DISAGREE with the current placement: the
    // table must trust the statuses, not the records.
    mockPipelineAssignments.mockReturnValue({
      data: [
        { deviceId: 101, agentNodeId: MAC, pinned: false, reason: 'capacity' },
        { deviceId: 102, agentNodeId: MAC, pinned: true, reason: 'manual' },
      ],
    })
  })

  it('links the camera name to the device page', () => {
    mockCameraStatuses.mockReturnValue({
      data: [cameraStatus(101, { detectionNodeId: MAC, decoderNodeId: MAC, audioNodeId: null })],
    })
    renderWithRouter(<NodeCameraAssignmentsTable nodeId={MAC} />)
    const link = screen.getByRole('link', { name: 'Front Door' })
    expect(link.getAttribute('href')).toBe('/devices/101')
  })

  it('shows only cameras whose CURRENT assignment includes this node', () => {
    mockCameraStatuses.mockReturnValue({
      data: [
        cameraStatus(101, { detectionNodeId: MAC, decoderNodeId: MAC, audioNodeId: null }),
        cameraStatus(102, { detectionNodeId: 'hub', decoderNodeId: null, audioNodeId: null }),
      ],
    })
    renderWithRouter(<NodeCameraAssignmentsTable nodeId={MAC} />)
    expect(screen.getByTitle('Front Door')).toBeInTheDocument()
    expect(screen.queryByTitle('Garden')).toBeNull()
  })

  it('includes a camera when only its decoder role lives on this node', () => {
    mockCameraStatuses.mockReturnValue({
      data: [cameraStatus(102, { detectionNodeId: 'hub', decoderNodeId: MAC, audioNodeId: null })],
    })
    renderWithRouter(<NodeCameraAssignmentsTable nodeId={MAC} />)
    expect(screen.getByTitle('Garden')).toBeInTheDocument()
  })

  it('shows the roles held here as labels, never as checkbox look-alikes', () => {
    mockCameraStatuses.mockReturnValue({
      data: [cameraStatus(101, { detectionNodeId: MAC, decoderNodeId: MAC, audioNodeId: 'hub' })],
    })
    renderWithRouter(<NodeCameraAssignmentsTable nodeId={MAC} />)
    const row = rowOf('Front Door')
    expect(within(row).getByText('Detection')).toBeInTheDocument()
    expect(within(row).getByText('Decode')).toBeInTheDocument()
    // Audio runs on the hub: named on its pill, not as checkbox chrome.
    expect(within(row).getByText('Audio')).toBeInTheDocument()
    expect(within(row).getByText('Hub')).toBeInTheDocument()
    expect(within(row).queryByRole('checkbox')).toBeNull()
    expect(
      row.querySelector('.lucide-square, .lucide-square-check-big, .lucide-check-square'),
    ).toBeNull()
  })

  it('shows the empty state when no camera is currently assigned here', () => {
    mockCameraStatuses.mockReturnValue({
      data: [
        cameraStatus(101, { detectionNodeId: 'hub', decoderNodeId: 'hub', audioNodeId: 'hub' }),
      ],
    })
    renderWithRouter(<NodeCameraAssignmentsTable nodeId={MAC} />)
    expect(screen.getByText('No camera runs on this node right now')).toBeInTheDocument()
  })
})
