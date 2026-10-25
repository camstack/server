import { describe, it, expect } from 'vitest'
import { formatProbedSummary } from '../stream-broker/probed-summary.js'

describe('formatProbedSummary', () => {
  it('renders full video + audio summary with as-of', () => {
    const s = formatProbedSummary(
      { codec: 'h264', resolution: { width: 640, height: 360 }, fps: 14.9 },
      {
        codec: 'h264',
        bitrateKbps: 5,
        idrIntervalMs: 4000,
        audio: { codec: 'MPEG4-GENERIC', sampleRate: 16000, channels: 1, supported: true },
        at: 0,
      },
      { asOf: '10:38' },
    )
    expect(s).toBe(
      'H.264 · 640×360 · 15fps · 5 kbps · IDR 4.0s · Audio: MPEG4-GENERIC 16kHz mono · as of 10:38',
    )
  })

  it('formats H.265, Mbps bitrate, stereo audio', () => {
    const s = formatProbedSummary(
      { codec: 'hevc', resolution: { width: 3840, height: 2160 }, fps: 30 },
      {
        codec: 'h265',
        bitrateKbps: 2500,
        idrIntervalMs: 2000,
        audio: { codec: 'AAC', sampleRate: 48000, channels: 2, supported: true },
        at: 0,
      },
    )
    expect(s).toBe('H.265 · 3840×2160 · 30fps · 2.5 Mbps · IDR 2.0s · Audio: AAC 48kHz stereo')
  })

  it('marks unsupported audio and renders 44.1kHz / multi-channel', () => {
    const s = formatProbedSummary(
      { codec: 'h264' },
      {
        bitrateKbps: 800,
        idrIntervalMs: 1000,
        audio: { codec: 'PCM', sampleRate: 44100, channels: 6, supported: false },
        at: 0,
      },
    )
    expect(s).toBe('H.264 · 800 kbps · IDR 1.0s · Audio: PCM 44.1kHz 6ch (unsupported)')
  })

  it('renders "Audio: none" when the stream has no audio track', () => {
    const s = formatProbedSummary(
      { codec: 'h264', resolution: { width: 1920, height: 1080 }, fps: 25 },
      { codec: 'h264', bitrateKbps: 1200, idrIntervalMs: 2000, audio: null, at: 0 },
    )
    expect(s).toBe('H.264 · 1920×1080 · 25fps · 1.2 Mbps · IDR 2.0s · Audio: none')
  })

  it('falls back to declared values + "not yet probed" when never streamed', () => {
    const s = formatProbedSummary(
      { codec: 'h265', resolution: { width: 896, height: 512 }, fps: 12 },
      null,
    )
    expect(s).toBe('H.265 · 896×512 · 12fps · Audio: — (not yet probed)')
  })

  it('prefers the detected (snapshot) codec over the declared one', () => {
    const s = formatProbedSummary(
      { codec: 'h265' },
      { codec: 'h264', bitrateKbps: 100, idrIntervalMs: 0, audio: null, at: 0 },
    )
    expect(s).toBe('H.264 · 100 kbps · Audio: none')
  })

  it('omits IDR when interval is zero/unknown', () => {
    const s = formatProbedSummary(
      { codec: 'h264' },
      { bitrateKbps: 50, idrIntervalMs: 0, audio: null, at: 0 },
    )
    expect(s).toBe('H.264 · 50 kbps · Audio: none')
  })

  it('returns "not yet probed" when nothing is known', () => {
    const s = formatProbedSummary({}, null)
    expect(s).toBe('not yet probed')
  })

  it('omits not-yet-measured bitrate (0) and near-zero IDR on a fresh force-probe', () => {
    const s = formatProbedSummary(
      { codec: 'h265', resolution: { width: 3840, height: 2160 }, fps: 25 },
      {
        codec: 'h265',
        bitrateKbps: 0,
        idrIntervalMs: 1,
        audio: { codec: 'PCMU', sampleRate: 8000, channels: 1, supported: true },
        at: 0,
      },
      { asOf: '13:17' },
    )
    expect(s).toBe('H.265 · 3840×2160 · 25fps · Audio: PCMU 8kHz mono · as of 13:17')
  })
})
