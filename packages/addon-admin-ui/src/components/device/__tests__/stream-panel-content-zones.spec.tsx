// @vitest-environment jsdom
/**
 * The camera card offers "Show zones" only when the camera has zones: the
 * zones overlay reaches the StreamPanel on `present`, and neither while the
 * slice is unanswered nor when the camera has none.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const state = vi.hoisted(() => ({
  presence: 'absent' as 'pending' | 'present' | 'absent',
  panelProps: null as Record<string, unknown> | null,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceZonesPresence: () => state.presence,
    useDeviceWebrtc: () => ({ streams: [], pipelineMetrics: null }),
    useDeviceSnapshotImage: () => ({ src: null, loading: false, refresh: vi.fn() }),
    usePlayerOverlayLayers: () => [],
    useVodPlayback: () => ({ request: null }),
    ZonesReadOnlyLayer: () => null,
    StreamPanel: (props: Record<string, unknown>) => {
      state.panelProps = props
      return null
    },
  }
})
vi.mock('../../../hooks/useDeviceDetections', () => ({
  useDeviceDetections: () => ({ phase: 'idle' }),
}))
vi.mock('../../detection-intelligence/use-stationary-objects', () => ({
  useStationaryObjects: () => ({ rows: [] }),
}))
vi.mock('../../../hooks/useDeviceIntercom', () => ({
  useDeviceIntercom: () => ({ state: 'idle', isTalking: false, start: vi.fn(), stop: vi.fn() }),
}))

import { StreamPanelContent } from '../PanelContent'

function overlayFor(presence: 'pending' | 'present' | 'absent'): unknown {
  state.presence = presence
  state.panelProps = null
  render(<StreamPanelContent deviceId={7} />)
  return state.panelProps?.['zonesOverlay']
}

describe('StreamPanelContent zones switch wiring', () => {
  it('passes no zones overlay when the camera has no zones or the slice is unanswered', () => {
    expect(overlayFor('absent')).toBeUndefined()
    expect(overlayFor('pending')).toBeUndefined()
  })

  it('passes the zones overlay when the camera has zones', () => {
    expect(overlayFor('present')).toBeDefined()
  })
})
