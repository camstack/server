// @vitest-environment jsdom
import './setup.js'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

interface QueryResult<T> {
  data?: T
  isError?: boolean
}

const previewHook = vi.fn<(input: unknown, options: unknown) => QueryResult<unknown>>()
const statsHook = vi.fn<(input: unknown, options: unknown) => QueryResult<unknown>>()

vi.mock('@dominevo/ui-library', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useStreamBrokerPreviewDerivedEncode: (input: unknown, options: unknown) =>
    previewHook(input, options),
  useStreamBrokerGetBrokerStats: (input: unknown, options: unknown) => statsHook(input, options),
  useDeviceManagerUpdateDeviceField: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
}))

import { FfmpegParamsField } from '../FfmpegParamsField.js'

const PREVIEW = {
  encoder: 'libx264',
  fps: 20,
  gopFrames: 40,
  targetKbps: 300,
  capKbps: 400,
  bufsizeKbps: 800,
  audio: 'aac',
  width: 854,
  height: 480,
  videoCodec: 'h264',
  requestedFps: null,
  fpsClampedToSource: false,
  floorKbps: 250,
  raisedToFloor: false,
  requestedKbps: null,
  keyframeIntervalSec: 2,
  args: ['-c:v', 'libx264'],
}

const mountWidget = (config: Record<string, unknown> = {}) =>
  render(
    <FfmpegParamsField
      instanceId="w"
      host="device-tab"
      deviceId={7}
      config={{
        fieldKey: 'derivedProfile:low',
        writerCapName: 'stream-broker',
        writerAddonId: 'stream-broker',
        ...config,
      }}
    />,
  )

const PreviewInput = z.object({
  deviceId: z.number(),
  profile: z.object({ video: z.object({ codec: z.string() }) }),
})

/** The last input the preview hook was called with, validated rather than cast. */
const lastInput = (): z.infer<typeof PreviewInput> & { readonly raw: unknown } => {
  const raw = previewHook.mock.calls[previewHook.mock.calls.length - 1]?.[0]
  return { ...PreviewInput.parse(raw), raw }
}

describe('FfmpegParamsField wrapper: the preview query', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    previewHook.mockReset()
    statsHook.mockReset()
    previewHook.mockReturnValue({ data: { kind: 'preview', preview: PREVIEW } })
    statsHook.mockReturnValue({})
  })
  afterEach(() => vi.useRealTimers())

  it('is keyed on the profile, debounced by 300 ms', () => {
    mountWidget()
    expect(lastInput().profile.video.codec).toBe('copy')

    fireEvent.click(screen.getByRole('switch', { name: /^video codec$/i }))
    // The edit is on screen at once, the query has not moved yet.
    expect(lastInput().profile.video.codec).toBe('copy')
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(lastInput().profile.video.codec).toBe('copy')
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(lastInput().profile.video.codec).toBe('h264')
    expect(lastInput().deviceId).toBe(7)
  })

  it('a burst of edits asks once for the last one', () => {
    mountWidget()
    fireEvent.click(screen.getByRole('switch', { name: /^video codec$/i }))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    fireEvent.click(screen.getByRole('switch', { name: /^audio$/i }))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(lastInput().profile.video.codec).toBe('copy')
    act(() => {
      vi.advanceTimersByTime(101)
    })
    expect(lastInput().profile.video.codec).toBe('h264')
  })

  it('names the source when the stream has a valid one, omits it otherwise', () => {
    mountWidget({ previewSource: { kind: 'profile', profile: 'low' } })
    expect(lastInput().raw).toHaveProperty('source')
    previewHook.mockClear()
    mountWidget({ previewSource: 'garbage' })
    expect(lastInput().raw).not.toHaveProperty('source')
  })

  it('is disabled for the args-only editor', () => {
    mountWidget({ argsOnly: true })
    expect(previewHook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    )
  })

  it('renders the answer: a plan, then no-source, then an error as unavailable', () => {
    const { unmount } = mountWidget()
    expect(screen.getByTestId('encode-result')).toHaveTextContent('854×480')
    unmount()

    previewHook.mockReturnValue({ data: { kind: 'no-source' } })
    const second = mountWidget()
    expect(screen.getByTestId('encode-result')).toHaveTextContent(/source has not been probed yet/i)
    second.unmount()

    previewHook.mockReturnValue({ isError: true })
    mountWidget()
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/not available right now/i)
    expect(panel).not.toHaveTextContent(/probed/i)
  })
})

describe('FfmpegParamsField wrapper: broker stats feed the running badge', () => {
  beforeEach(() => {
    previewHook.mockReset()
    statsHook.mockReset()
    previewHook.mockReturnValue({ data: { kind: 'preview', preview: PREVIEW } })
  })

  it('a failed stats query is never "not running"', () => {
    statsHook.mockReturnValue({ isError: true })
    mountWidget({ statsBrokerId: '7/derived:low' })
    expect(screen.getByTestId('encode-result')).not.toHaveTextContent(/not running/i)
  })

  it('stats without derivedEncode mean not running', () => {
    statsHook.mockReturnValue({ data: {} })
    mountWidget({ statsBrokerId: '7/derived:low' })
    expect(screen.getByTestId('encode-result')).toHaveTextContent(/not running/i)
  })

  it('stats with derivedEncode show the stream as running', () => {
    statsHook.mockReturnValue({ data: { derivedEncode: PREVIEW } })
    mountWidget({ statsBrokerId: '7/derived:low' })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/running/i)
    expect(panel).not.toHaveTextContent(/not running/i)
  })

  it('queries the configured broker, polled every 5 s; without an id it is disabled', () => {
    statsHook.mockReturnValue({ data: {} })
    mountWidget({ statsBrokerId: '7/derived:low' })
    expect(statsHook).toHaveBeenCalledWith(
      { brokerId: '7/derived:low' },
      expect.objectContaining({ enabled: true, refetchInterval: 5000 }),
    )
    statsHook.mockClear()
    mountWidget()
    expect(statsHook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    )
  })
})
