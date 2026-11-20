// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../camera-stream-player', () => ({
  CameraStreamPlayer: () => <div />,
}))
vi.mock('../detection-overlay', () => ({
  DetectionOverlay: () => <div data-testid="detection-boxes" />,
}))

import { containedImageBox, StreamPanel, type StreamPanelProps } from '../stream-panel'

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

describe('boxes map onto the displayed image', () => {
  it('a rotated (portrait) camera is pillarboxed: the rect is the image, not the 16:9 box', () => {
    const box = containedImageBox(1080, 1920)
    expect(box.height).toBe(100)
    expect(box.top).toBe(0)
    expect(box.width).toBeCloseTo((9 / 16 / (16 / 9)) * 100, 5)
    expect(box.left).toBeCloseTo((100 - box.width) / 2, 5)
  })

  it('a 4:3 camera is pillarboxed, a 21:9 one letterboxed, 16:9 fills the box', () => {
    expect(containedImageBox(1600, 1200).width).toBeCloseTo(75, 5)
    const wide = containedImageBox(2100, 900)
    expect(wide.width).toBe(100)
    expect(wide.height).toBeCloseTo((16 / 9 / (21 / 9)) * 100, 5)
    expect(containedImageBox(1920, 1080)).toEqual({ left: 0, top: 0, width: 100, height: 100 })
    expect(containedImageBox(0, 0)).toEqual({ left: 0, top: 0, width: 100, height: 100 })
  })

  it('the overlay is placed inside the loaded image rect of a portrait still', () => {
    draw({ defaultShowDetections: true, detectionsOnSnapshot: true })
    const img = screen.getByAltText('Camera snapshot')
    Object.defineProperty(img, 'naturalWidth', { value: 1080 })
    Object.defineProperty(img, 'naturalHeight', { value: 1920 })
    fireEvent.load(img)
    const layer = screen.getByTestId('snapshot-image-overlay')
    expect(layer.style.height).toBe('100%')
    expect(Number.parseFloat(layer.style.width)).toBeCloseTo(31.640625, 4)
    expect(layer.contains(screen.getByTestId('detection-boxes'))).toBe(true)
  })

  it('motion on the still follows the Show motion switch, off by default', () => {
    draw({ defaultShowDetections: false, defaultShowMotion: true, detectionsOnSnapshot: true })
    expect(screen.getByTestId('detection-boxes')).toBeTruthy()
  })

  it('zones are off until the operator switches them on, then sit in the portrait image rect', () => {
    draw({ zonesOverlay: <div data-testid="zones-layer" /> })
    const img = screen.getByAltText('Camera snapshot')
    Object.defineProperty(img, 'naturalWidth', { value: 1080 })
    Object.defineProperty(img, 'naturalHeight', { value: 1920 })
    fireEvent.load(img)
    expect(screen.queryByTestId('zones-layer')).toBeNull()
    fireEvent.click(screen.getByTitle('More controls'))
    fireEvent.click(screen.getByText('Show zones'))
    const layer = screen.getByTestId('snapshot-image-overlay')
    expect(layer.style.height).toBe('100%')
    expect(Number.parseFloat(layer.style.width)).toBeCloseTo(31.640625, 4)
    expect(layer.contains(screen.getByTestId('zones-layer'))).toBe(true)
  })

  it('offers no Show zones switch without a zones layer', () => {
    draw({})
    fireEvent.click(screen.getByTitle('More controls'))
    expect(screen.queryByText('Show zones')).toBeNull()
  })
})
