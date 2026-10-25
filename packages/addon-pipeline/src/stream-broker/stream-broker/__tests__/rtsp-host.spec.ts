import { describe, it, expect } from 'vitest'
import { substituteRtspHost } from '../rtsp-host'

describe('substituteRtspHost', () => {
  it('swaps the host, preserving port and token path', () => {
    expect(substituteRtspHost('rtsp://127.0.0.1:8554/abc123', '192.168.10.10')).toBe(
      'rtsp://192.168.10.10:8554/abc123',
    )
  })

  it('preserves a multi-segment path (e.g. /token/muted)', () => {
    expect(substituteRtspHost('rtsp://127.0.0.1:8554/abc123/muted', 'hub.local')).toBe(
      'rtsp://hub.local:8554/abc123/muted',
    )
  })

  it('returns the URL untouched when host is undefined', () => {
    expect(substituteRtspHost('rtsp://127.0.0.1:8554/abc123', undefined)).toBe(
      'rtsp://127.0.0.1:8554/abc123',
    )
  })

  it('returns the URL untouched when host is empty', () => {
    expect(substituteRtspHost('rtsp://127.0.0.1:8554/abc123', '')).toBe(
      'rtsp://127.0.0.1:8554/abc123',
    )
  })

  it('returns the original string when the URL is unparseable', () => {
    expect(substituteRtspHost('not a url', 'hub.local')).toBe('not a url')
  })

  it('accepts an IPv4 host', () => {
    expect(substituteRtspHost('rtsp://127.0.0.1:1234/t', '10.0.0.5')).toBe('rtsp://10.0.0.5:1234/t')
  })
})
