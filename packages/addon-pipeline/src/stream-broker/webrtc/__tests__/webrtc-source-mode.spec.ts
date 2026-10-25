import { describe, expect, it } from 'vitest'
import { resolveWebrtcSourceMode } from '../webrtc-source-mode.js'

describe('resolveWebrtcSourceMode', () => {
  it('local when this node is the owner (byte-identical path today)', () => {
    expect(resolveWebrtcSourceMode({ ownerNodeId: 'hub', ownNodeId: 'hub' })).toEqual({
      kind: 'local',
    })
  })
  it('local when owner is this agent', () => {
    expect(
      resolveWebrtcSourceMode({ ownerNodeId: 'agent-a', ownNodeId: 'agent-a', reachableHost: 'x' }),
    ).toEqual({ kind: 'local' })
  })
  it('remote-adapter when owner is a different, reachable node', () => {
    expect(
      resolveWebrtcSourceMode({
        ownerNodeId: 'agent-a',
        ownNodeId: 'hub',
        reachableHost: '10.0.0.9',
      }),
    ).toEqual({ kind: 'remote-adapter', ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
  })
  it('unresolvable when owner differs but has no reachableHost', () => {
    expect(resolveWebrtcSourceMode({ ownerNodeId: 'agent-a', ownNodeId: 'hub' })).toEqual({
      kind: 'unresolvable',
      ownerNodeId: 'agent-a',
    })
  })
})
