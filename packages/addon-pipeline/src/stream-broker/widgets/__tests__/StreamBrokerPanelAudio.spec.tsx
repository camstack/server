// @vitest-environment jsdom
/**
 * The stream-broker panel's per-camera audio control — the WRITE side
 * ([D113](../../../../../../docs/decisions/adr-0113.md) phase 3,
 * `broker-audio`).
 *
 * This is the row that would have become PERMANENTLY UNWRITABLE if the
 * deprecated `pipelineOrchestrator.setCameraSwitch` shim were deleted first:
 * nothing else in any UI wrote `streamBroker.setDeviceAudioMute`, and the shim
 * was also the only caller that node-pinned it.
 *
 * So three things are pinned here:
 *  - the REAL authority is written, never the shim;
 *  - the write CARRIES THE ROUTING KEY of the camera's source owner (an
 *    unrouted write persists an override on a node with no broker for this
 *    camera — a write nothing reads);
 *  - state survives the surface change: a camera muted through the old group
 *    renders muted here on the first read, with no write on mount.
 */
import './setup.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setDeviceAudioMute = vi.fn()
/** The deprecated shim. Mocked ONLY so calling it can be caught. */
const setCameraSwitch = vi.fn()

let audioMuteData: unknown = { muted: false, appliedBrokers: 1 }
let sourceNodeId: string | null = 'agent-a'
/** The input the panel handed the read hook — the routing key must be in it. */
let lastReadInput: unknown = null

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceProxy: () => null,
  useEventInvalidation: () => undefined,
  useEventStreamLatest: () => null,
  usePipelineOrchestratorGetCameraStatus: () => ({
    data: sourceNodeId === null ? undefined : { assignment: { sourceNodeId } },
  }),
  useStreamBrokerApplyDeviceSettingsPatch: () => ({ mutate: vi.fn(), isPending: false }),
  useStreamBrokerGetDeviceSettingsContribution: () => ({ data: undefined }),
  useStreamBrokerKillClient: () => ({ mutate: vi.fn(), isPending: false }),
  useStreamBrokerListAllProfileSlots: () => ({ data: [] }),
  useStreamBrokerListClients: () => ({ data: undefined }),
  useStreamBrokerGetDeviceAudioMute: (input: unknown) => {
    lastReadInput = input
    return { data: audioMuteData }
  },
  useStreamBrokerSetDeviceAudioMute: () => ({ mutate: setDeviceAudioMute, isPending: false }),
  usePipelineOrchestratorSetCameraSwitch: () => ({ mutate: setCameraSwitch, isPending: false }),
  useSystem: () => ({ trpcClient: {} }),
}))

import { StreamBrokerPanelInner } from '../StreamBrokerPanel.js'

function renderPanel(deviceId = 102): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <StreamBrokerPanelInner deviceId={deviceId} />
    </QueryClientProvider>,
  )
}

function audioSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Audio' })
}

beforeEach(() => {
  setDeviceAudioMute.mockReset()
  setCameraSwitch.mockReset()
  audioMuteData = { muted: false, appliedBrokers: 1 }
  sourceNodeId = 'agent-a'
  lastReadInput = null
})

afterEach(() => {
  cleanup()
})

describe('StreamBrokerPanel — per-camera audio', () => {
  it('muting writes the REAL authority, carrying the source owner as the routing key', () => {
    renderPanel(102)
    fireEvent.click(audioSwitch())
    expect(setDeviceAudioMute).toHaveBeenCalledTimes(1)
    expect(setDeviceAudioMute).toHaveBeenCalledWith({
      deviceId: 102,
      muted: true,
      nodeId: 'agent-a',
    })
    expect(setCameraSwitch).not.toHaveBeenCalled()
  })

  it('READS on the source owner too — an unrouted read answers for the hub', () => {
    renderPanel(102)
    expect(lastReadInput).toEqual({ deviceId: 102, nodeId: 'agent-a' })
  })

  it('STATE SURVIVAL: a camera muted through the deprecated group renders muted, writing nothing on mount', () => {
    audioMuteData = { muted: true, appliedBrokers: 2 }
    renderPanel(102)
    expect(screen.getByText('Audio muted')).toBeTruthy()
    expect(audioSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(setDeviceAudioMute).not.toHaveBeenCalled()
  })

  it('un-muting writes muted: false on the same node', () => {
    audioMuteData = { muted: true, appliedBrokers: 2 }
    renderPanel(102)
    fireEvent.click(audioSwitch())
    expect(setDeviceAudioMute).toHaveBeenCalledWith({
      deviceId: 102,
      muted: false,
      nodeId: 'agent-a',
    })
  })

  it('an unresolved source owner is UNKNOWN and writes nothing — never the hub by default', () => {
    sourceNodeId = null
    renderPanel(102)
    expect(screen.getByText('Audio unknown')).toBeTruthy()
    expect(audioSwitch()).toHaveProperty('disabled', true)
    fireEvent.click(audioSwitch())
    expect(setDeviceAudioMute).not.toHaveBeenCalled()
  })
})
