// @vitest-environment jsdom
/**
 * The stream-broker panel's per-profile stats row (D762).
 *
 * The broker decodes nothing: decoding runs in the per-session decode workers,
 * and the broker's frame-handle plane — the only thing that fed a decode rate,
 * a decoded-subscriber count and a decoder node — had no caller. Those three
 * read "0 fps" / 0 / "deferred" on every live camera. The row now shows only
 * what the broker measures: the rate it RECEIVES.
 */
import './setup.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SLOT = {
  deviceId: 102,
  profile: 'high',
  brokerId: '102/native:main',
  sourceCamStreamId: 'native:main',
  status: 'streaming',
  resolution: { width: 1920, height: 1080 },
  codec: 'h264',
  preBufferSec: 5,
}

const STATS = {
  status: 'streaming',
  inputFps: 24.6,
  encodedSubscribers: 1,
  uptimeMs: 60_000,
  bitrateKbps: 4000,
  idrIntervalMs: 2000,
  codec: 'h264',
  totalBytes: 1_000_000,
  packetCount: 1500,
  rtspClients: 1,
  pipeClients: 0,
  preBufferSec: 5,
  preBufferMs: 4000,
  preBufferPackets: 120,
  audio: null,
}

const CLIENTS = {
  rtsp: [],
  audio: [],
  encoded: [],
  pipeClients: 0,
  encodedSubscribers: 1,
}

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceProxy: () => null,
  useEventInvalidation: () => undefined,
  useEventStreamLatest: (_topic: string, filter: (d: { brokerId: string }) => boolean) => {
    const snapshot = {
      brokerId: SLOT.brokerId,
      deviceId: 102,
      profile: 'high',
      nodeId: 'hub',
      stats: STATS,
      timestamp: 0,
    }
    return filter(snapshot) ? snapshot : null
  },
  usePipelineOrchestratorGetCameraStatus: () => ({ data: { assignment: { sourceNodeId: 'hub' } } }),
  useStreamBrokerApplyDeviceSettingsPatch: () => ({ mutate: vi.fn(), isPending: false }),
  useStreamBrokerGetDeviceSettingsContribution: () => ({ data: undefined }),
  useStreamBrokerKillClient: () => ({ mutate: vi.fn(), isPending: false }),
  useStreamBrokerListAllProfileSlots: () => ({ data: [SLOT] }),
  useStreamBrokerListClients: () => ({ data: CLIENTS }),
  useStreamBrokerGetDeviceAudioMute: () => ({ data: { muted: false, appliedBrokers: 1 } }),
  useStreamBrokerSetDeviceAudioMute: () => ({ mutate: vi.fn(), isPending: false }),
  useSystem: () => ({ trpcClient: {} }),
}))

import { StreamBrokerPanelInner } from '../StreamBrokerPanel.js'

function renderPanel(variant: 'full' | 'compact'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <StreamBrokerPanelInner deviceId={102} variant={variant} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('StreamBrokerPanel — stats carry no decode plane (D762)', () => {
  it('the full row shows the input rate and no decode rate or decoder node', () => {
    renderPanel('full')
    expect(screen.getByText('24.6 fps')).toBeTruthy()
    expect(screen.queryByText('Dec:')).toBeNull()
    expect(screen.queryByText('Decoder:')).toBeNull()
    expect(screen.queryByText('deferred')).toBeNull()
  })

  it('the compact row shows the input rate alone, not "in/decoded"', () => {
    renderPanel('compact')
    expect(screen.getByText('24.6 fps')).toBeTruthy()
    expect(screen.queryByText(/\/0\.0/)).toBeNull()
  })
})
