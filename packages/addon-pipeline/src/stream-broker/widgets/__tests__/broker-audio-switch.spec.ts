/**
 * The per-camera broker audio mute — the derivation behind D113's
 * `broker-audio` row.
 *
 * The property worth a whole spec file is the NODE. `stream-broker` is a
 * per-node singleton; an unrouted read answers for the hub's brokers and an
 * unrouted write persists an override on a node that serves nothing for this
 * camera. Both look like success. So the routing key is part of the state, not
 * a detail of the call site.
 */
import { describe, expect, it } from 'vitest'
import { brokerAudioWrite, resolveBrokerAudio } from '../broker-audio-switch.js'

describe('resolveBrokerAudio', () => {
  it('an unmuted camera on a known node reads ON', () => {
    const state = resolveBrokerAudio({ muted: false, sourceNodeId: 'hub' })
    expect(state.on).toBe(true)
    expect(state.available).toBe(true)
    expect(state.nodeId).toBe('hub')
  })

  it('STATE SURVIVAL: a camera muted through the deprecated group reads OFF on the first read', () => {
    const state = resolveBrokerAudio({ muted: true, sourceNodeId: 'agent-a' })
    expect(state.on).toBe(false)
    expect(state.available).toBe(true)
  })

  it('an UNRESOLVED source node is unknown — even with a `muted` value in hand', () => {
    // That value came from whichever node the call happened to reach. Reporting
    // it would be a confident answer about a broker somewhere else.
    const state = resolveBrokerAudio({ muted: false, sourceNodeId: null })
    expect(state.on).toBeNull()
    expect(state.available).toBe(false)
    expect(state.nodeId).toBeNull()
  })

  it('an empty source node is treated as unresolved, not as a node name', () => {
    const state = resolveBrokerAudio({ muted: false, sourceNodeId: '' })
    expect(state.available).toBe(false)
  })

  it('a read that did not answer is unknown, never "audio is flowing"', () => {
    const state = resolveBrokerAudio({ muted: null, sourceNodeId: 'hub' })
    expect(state.on).toBeNull()
    expect(state.available).toBe(false)
  })

  it('an in-flight write wins over the last answer', () => {
    const state = resolveBrokerAudio({ muted: false, sourceNodeId: 'hub', pendingOn: false })
    expect(state.on).toBe(false)
  })

  it('an in-flight write over an unknown read stays unknown', () => {
    const state = resolveBrokerAudio({ muted: null, sourceNodeId: 'hub', pendingOn: false })
    expect(state.on).toBeNull()
  })
})

describe('brokerAudioWrite', () => {
  it('turning it OFF writes muted: true, CARRYING the routing key', () => {
    const on = resolveBrokerAudio({ muted: false, sourceNodeId: 'agent-a' })
    expect(brokerAudioWrite(on, 102)).toEqual({
      deviceId: 102,
      muted: true,
      nodeId: 'agent-a',
    })
  })

  it('turning it ON writes muted: false on the same node', () => {
    const off = resolveBrokerAudio({ muted: true, sourceNodeId: 'agent-a' })
    expect(brokerAudioWrite(off, 102)).toEqual({
      deviceId: 102,
      muted: false,
      nodeId: 'agent-a',
    })
  })

  it('no routing key means NO write — never a silent fall back to the hub', () => {
    const unrouted = resolveBrokerAudio({ muted: false, sourceNodeId: null })
    expect(brokerAudioWrite(unrouted, 102)).toBeNull()
  })

  it('an unknown state produces no write', () => {
    const unknown = resolveBrokerAudio({ muted: null, sourceNodeId: 'hub' })
    expect(brokerAudioWrite(unknown, 102)).toBeNull()
  })
})
