// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A live player that reports a portrait frame (1080x1920) through the same
// handle the real one uses, and paints whatever overlay it is handed.
vi.mock('../camera-stream-player', () => ({
  CameraStreamPlayer: ({
    overlay,
    onVideoElement,
  }: {
    overlay?: ReactNode
    onVideoElement?: (el: HTMLVideoElement | null) => void
  }) => {
    useEffect(() => {
      const el = document.createElement('video')
      Object.defineProperty(el, 'videoWidth', { value: 1080 })
      Object.defineProperty(el, 'videoHeight', { value: 1920 })
      onVideoElement?.(el)
      return () => onVideoElement?.(null)
    }, [onVideoElement])
    return <div data-testid="player">{overlay}</div>
  },
}))
vi.mock('../detection-overlay', () => ({
  DetectionOverlay: () => <div data-testid="detection-boxes" />,
}))

import { StreamPanel, type StreamPanelProps } from '../stream-panel'

const never = vi.fn()

afterEach(cleanup)

function drawLive(extra: Partial<StreamPanelProps>): void {
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
    detections: { motion: null, motionRaw: [], detection: null, phase: 'idle' },
    defaultShowDetections: true,
    ...extra,
  } as unknown as StreamPanelProps
  render(<StreamPanel {...props} />)
}

describe('live overlays map onto the displayed video', () => {
  it('a portrait live frame puts the detection boxes inside the video rect', async () => {
    drawLive({})
    await act(async () => undefined)
    const layer = screen.getByTestId('live-image-overlay')
    expect(layer.style.height).toBe('100%')
    expect(Number.parseFloat(layer.style.width)).toBeCloseTo(31.640625, 4)
    expect(layer.contains(screen.getByTestId('detection-boxes'))).toBe(true)
  })

  it('an image-placed layer rides in the live image rect', async () => {
    drawLive({ imageExtraOverlay: <div data-testid="editor-layer" /> })
    await act(async () => undefined)
    const rect = screen.getByTestId('live-image-overlay')
    expect(rect.contains(screen.getByTestId('editor-layer'))).toBe(true)
  })

  it('zones ride in the same rect on the live view once switched on', async () => {
    drawLive({ zonesOverlay: <div data-testid="zones-layer" /> })
    await act(async () => undefined)
    fireEvent.click(screen.getByTitle('More controls'))
    fireEvent.click(screen.getByText('Show zones'))
    const layer = screen.getByTestId('live-image-overlay')
    expect(layer.contains(screen.getByTestId('zones-layer'))).toBe(true)
    expect(Number.parseFloat(layer.style.width)).toBeCloseTo(31.640625, 4)
  })
})
