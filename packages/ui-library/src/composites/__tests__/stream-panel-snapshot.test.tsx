// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../camera-stream-player', () => ({
  CameraStreamPlayer: () => <div />,
}))
vi.mock('../detection-overlay', () => ({
  DetectionOverlay: () => <div data-testid="detection-boxes" />,
}))

import { StreamPanel, type StreamPanelProps } from '../stream-panel'

const never = vi.fn()
const detections = {
  motion: null,
  motionRaw: [],
  detection: null,
  phase: 'idle',
}

function draw(extra: Partial<StreamPanelProps>): void {
  const props = {
    serverUrl: 'http://hub',
    createSession: never,
    sendAnswer: never,
    handleOffer: never,
    getIceServers: never,
    addIceCandidate: never,
    getIceCandidates: never,
    closeSession: never,
    getSessionState: never,
    showPlayStop: true,
    snapshotSrc: '/snap/7.jpg',
    detections,
    ...extra,
  } as unknown as StreamPanelProps
  render(<StreamPanel {...props} />)
}

afterEach(cleanup)

describe('StreamPanel snapshot', () => {
  it('offers a download only when the host names the file', () => {
    draw({})
    expect(screen.queryByTestId('stream-snapshot-download')).toBeNull()
    cleanup()
    draw({ snapshotDownloadName: 'snapshot-7.jpg' })
    const link = screen.getByTestId('stream-snapshot-download')
    expect(link.getAttribute('download')).toBe('snapshot-7.jpg')
    expect(link.getAttribute('href')).toBe('/snap/7.jpg')
  })

  it('draws boxes on the snapshot only when the host asks and the switch is on', () => {
    draw({ defaultShowDetections: true })
    expect(screen.queryByTestId('detection-boxes')).toBeNull()
    cleanup()
    draw({ defaultShowDetections: true, detectionsOnSnapshot: true })
    expect(screen.getByTestId('detection-boxes')).toBeTruthy()
    cleanup()
    draw({ defaultShowDetections: false, detectionsOnSnapshot: true })
    expect(screen.queryByTestId('detection-boxes')).toBeNull()
  })
})
