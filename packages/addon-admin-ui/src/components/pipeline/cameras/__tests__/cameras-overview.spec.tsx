/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CamerasOverview } from '../CamerasOverview'
import type { CameraStatus } from '@camstack/types'

expect.extend(jestDomMatchers)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseDeviceList = vi.fn()
const mockGetCameraStatuses = vi.fn()

// Path is relative to THIS test file's location in __tests__/:
// 4 levels up to reach src/ (cameras → pipeline → components → src).
vi.mock('../../../../hooks/useDevice', () => ({
  useDeviceList: () => mockUseDeviceList(),
}))

vi.mock('@camstack/ui-library', () => ({
  useUiText: () => (_key: string, fallback: string | { other: string }) =>
    typeof fallback === 'string' ? fallback : fallback.other,
  usePipelineOrchestratorGetCameraStatuses: () => mockGetCameraStatuses(),
  useDeviceManagerListAll: () => ({ data: undefined }),
  useClusterNodes: () => ({ nodes: [{ id: 'hub', name: 'hub', isOnline: true }] }),
  useLiveEvent: () => undefined,
  useAddonSettingsGetDeviceSettings: () => ({ data: null }),
  usePipelineOrchestratorResolvePipeline: () => ({ data: { steps: [], audio: null } }),
  usePipelineOrchestratorAssignPipeline: () => ({ mutate: vi.fn(), isPending: false }),
  usePipelineOrchestratorUnassignPipeline: () => ({ mutate: vi.fn(), isPending: false }),
  getPhaseVisual: (phase: string) => ({
    label: phase,
    textColor: '',
    badgeClass: '',
    dotClass: '',
    icon: 'Activity',
  }),
  PhaseIcon: () => null,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDevice(id: number, name: string, isCamera = true) {
  return {
    id,
    stableId: `stable-${id}`,
    addonId: 'addon-reolink',
    type: 'camera',
    name,
    parentDeviceId: null,
    online: true,
    features: [] as readonly string[],
    isCamera,
    config: {},
  }
}

function makeStatus(deviceId: number, opts: { actualFps?: number } = {}): CameraStatus {
  const { actualFps = 4.8 } = opts
  return {
    deviceId,
    fetchedAt: Date.now(),
    switchedOff: [],
    degraded: [],
    assignment: {
      detectionNodeId: 'node-a',
      decoderNodeId: 'node-a',
      audioNodeId: null,
      sourceNodeId: 'hub',
      pinned: { detection: false, decoder: false, audio: false },
      reasons: {},
    },
    source: {
      streams: [
        { camStreamId: 'main', codec: 'h264', width: 1920, height: 1080, fps: 15, kind: 'main' },
      ],
    },
    broker: {
      profiles: [
        {
          profile: 'high',
          status: 'streaming',
          codec: 'h264',
          width: 1920,
          height: 1080,
          subscribers: 1,
          inFps: 15,
        },
      ],
      webrtcSessions: 0,
      rtspRestream: true,
    },
    decoder: { nodeId: 'node-a' },
    motion: { enabled: true, fps: 4 },
    detection: {
      nodeId: 'node-a',
      engine: { backend: 'coreml', device: 'ane' },
      phase: 'active',
      configuredFps: 5,
      actualFps,
      queueDepth: 0,
      avgInferenceMs: 12,
      provisioning: { state: 'ready' },
    },
    audio: null,
    recording: null,
  }
}

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CamerasOverview refreshToken={0} />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CamerasOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders one card per camera device', () => {
    mockUseDeviceList.mockReturnValue({
      data: [makeDevice(1, 'Front Door'), makeDevice(2, 'Back Yard'), makeDevice(3, 'NVR', false)],
      isLoading: false,
    })
    mockGetCameraStatuses.mockReturnValue({
      data: [makeStatus(1), makeStatus(2)],
      isLoading: false,
    })

    renderOverview()

    expect(screen.getByText('Front Door')).toBeInTheDocument()
    expect(screen.getByText('Back Yard')).toBeInTheDocument()
    expect(screen.queryByText('NVR')).not.toBeInTheDocument()
  })

  it('shows an empty state when no cameras exist', () => {
    mockUseDeviceList.mockReturnValue({ data: [], isLoading: false })
    mockGetCameraStatuses.mockReturnValue({ data: [], isLoading: false })

    renderOverview()

    expect(screen.getByText('No cameras found')).toBeInTheDocument()
  })

  it('surfaces the black-hole signature loudly and sorts the broken camera first', () => {
    mockUseDeviceList.mockReturnValue({
      data: [makeDevice(1, 'Aaa Healthy'), makeDevice(2, 'Zzz Broken')],
      isLoading: false,
    })
    mockGetCameraStatuses.mockReturnValue({
      data: [makeStatus(1), makeStatus(2, { actualFps: 0 })],
      isLoading: false,
    })

    renderOverview()

    // The problem banner is visible…
    expect(screen.getByRole('alert')).toHaveTextContent(/black-hole/i)
    // …and the broken camera renders BEFORE the healthy one despite its name.
    const articles = screen.getAllByRole('article')
    expect(articles[0]).toHaveAccessibleName('Zzz Broken pipeline status')
    expect(articles[1]).toHaveAccessibleName('Aaa Healthy pipeline status')
  })

  it('renders detection runtime numbers from the polled status', () => {
    mockUseDeviceList.mockReturnValue({ data: [makeDevice(1, 'Cam')], isLoading: false })
    mockGetCameraStatuses.mockReturnValue({ data: [makeStatus(1)], isLoading: false })

    renderOverview()

    // 4.8 actual / 5 configured fps from the fixture.
    expect(screen.getByText('4.8')).toBeInTheDocument()
    expect(screen.getByText(/5 configured/)).toBeInTheDocument()
  })

  it('an active camera whose frames reach the detector shows no issue and no shared-memory rows', () => {
    // The status the hub serves today: the decoder block names the node only.
    mockUseDeviceList.mockReturnValue({ data: [makeDevice(1, 'Cam')], isLoading: false })
    mockGetCameraStatuses.mockReturnValue({ data: [makeStatus(1)], isLoading: false })

    renderOverview()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/shared-memory/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^SHM/)).not.toBeInTheDocument()
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument()
  })
})
