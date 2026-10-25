import { describe, it, expect } from 'vitest'
import { resolveRecordingHubHostname } from '../recording-hub-host'

describe('resolveRecordingHubHostname', () => {
  it('prefers a non-empty operator override', () => {
    expect(resolveRecordingHubHostname('hub.lan', 'https://192.168.10.5:4443')).toBe('hub.lan')
  })

  it('trims the override', () => {
    expect(resolveRecordingHubHostname('  hub.lan  ', undefined)).toBe('hub.lan')
  })

  it('derives the host from a full hub URL when no override', () => {
    expect(resolveRecordingHubHostname(undefined, 'https://192.168.10.5:4443')).toBe('192.168.10.5')
  })

  it('derives the host from a scheme-less authority', () => {
    expect(resolveRecordingHubHostname('', '192.168.10.5:4443')).toBe('192.168.10.5')
  })

  it('derives the host from a tcp:// hub address', () => {
    expect(resolveRecordingHubHostname(undefined, 'tcp://10.0.0.2:6000')).toBe('10.0.0.2')
  })

  it('handles a bare hostname with no port', () => {
    expect(resolveRecordingHubHostname(undefined, 'myhub')).toBe('myhub')
  })

  it('preserves a bracketed IPv6 authority (round-trips into an rtsp URL)', () => {
    expect(resolveRecordingHubHostname(undefined, 'https://[2a02::1]:4443')).toBe('[2a02::1]')
  })

  it('returns undefined when neither source yields a host', () => {
    expect(resolveRecordingHubHostname(undefined, undefined)).toBeUndefined()
    expect(resolveRecordingHubHostname('   ', '')).toBeUndefined()
  })
})
