import { describe, expect, it } from 'vitest'
import {
  compareSrflxMappings,
  distinctStunDestinations,
  type SrflxObservation,
} from '../webrtc-diagnostics/nat-mapping.js'

const obs = (over: Partial<SrflxObservation> = {}): SrflxObservation => ({
  address: '203.0.113.7',
  port: 61000,
  protocol: 'udp',
  relatedAddress: '192.0.2.10',
  relatedPort: 50000,
  url: 'stun:stun.a.example:3478',
  ...over,
})

describe('compareSrflxMappings', () => {
  it('two servers, two different mapped ports for the same base → endpoint-dependent (symmetric)', () => {
    const v = compareSrflxMappings(
      [obs(), obs({ port: 61017, url: 'stun:stun.b.example:19302' })],
      2,
    )
    expect(v.kind).toBe('endpoint-dependent')
  })

  it('two servers answering with the same mapping → endpoint-independent, confirmed', () => {
    const v = compareSrflxMappings([obs(), obs({ url: 'stun:stun.b.example:19302' })], 2)
    expect(v.kind).toBe('endpoint-independent')
    expect(v.confidence).toBe('confirmed')
  })

  it('one mapping seen with two servers queried → endpoint-independent, likely (the browser drops duplicates)', () => {
    const v = compareSrflxMappings([obs()], 2)
    expect(v.kind).toBe('endpoint-independent')
    expect(v.confidence).toBe('likely')
  })

  it('a single STUN server cannot tell → unknown', () => {
    const v = compareSrflxMappings([obs(), obs({ port: 61017 })], 1)
    expect(v.kind).toBe('unknown')
  })

  it('no srflx at all → unknown, never "independent"', () => {
    const v = compareSrflxMappings([], 2)
    expect(v.kind).toBe('unknown')
  })

  it('different local bases are compared separately', () => {
    const v = compareSrflxMappings(
      [
        obs(),
        obs({ relatedAddress: '10.0.0.4', relatedPort: 40000, port: 62000, url: 'stun:b:1' }),
      ],
      2,
    )
    expect(v.kind).toBe('endpoint-independent')
  })

  it('a hidden base (0.0.0.0 / rport 0) groups by the public address', () => {
    const v = compareSrflxMappings(
      [
        obs({ relatedAddress: '0.0.0.0', relatedPort: 0 }),
        obs({ relatedAddress: '0.0.0.0', relatedPort: 0, port: 61999, url: 'stun:b:1' }),
      ],
      2,
    )
    expect(v.kind).toBe('endpoint-dependent')
  })

  it('ignores TCP srflx', () => {
    const v = compareSrflxMappings([obs({ protocol: 'tcp' })], 2)
    expect(v.kind).toBe('unknown')
  })
})

describe('distinctStunDestinations', () => {
  it('counts host:port pairs, dropping query strings and TURN entries', () => {
    expect(
      distinctStunDestinations([
        'stun:stun.a.example:3478',
        'stun:stun.a.example:3478?transport=udp',
        'stun:stun.a.example:53',
        'turn:turn.example:3478',
      ]),
    ).toEqual(['stun:stun.a.example:3478', 'stun:stun.a.example:53'])
  })
})
