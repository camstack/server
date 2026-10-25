import { describe, expect, it } from 'vitest'
import { buildPeerConnectionConfig } from '../peer-connection-config.js'

describe('buildPeerConnectionConfig', () => {
  it('keeps production unchanged: no iceTransportPolicy key unless one is asked for', () => {
    const cfg = buildPeerConnectionConfig([{ urls: 'turn:t.example:3478' }], undefined)
    expect('iceTransportPolicy' in cfg).toBe(false)
    expect(cfg.iceServers).toEqual([
      { urls: 'turn:t.example:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
    ])
  })

  it('applies a diagnostic relay policy', () => {
    const cfg = buildPeerConnectionConfig(undefined, 'relay')
    expect(cfg.iceTransportPolicy).toBe('relay')
  })
})
