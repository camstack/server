/**
 * P2d — source-owner assignment + runner frame-source selection (pure).
 *
 * Two pure functions back the orchestrator's Phase-2 seams:
 *
 * - `resolveSourceOwner`: WHO owns a camera's source pull. Gated by the
 *   `remoteSourcingNodes` rollout knob: while the knob is EMPTY (default —
 *   rollout OFF) ownership stays UNMODELED (`undefined`), which makes
 *   `computeFrameSourceNodes` collapse to the global `enabledDecoderNodes` —
 *   bit-identical to pre-Phase-2 behavior. With the knob populated, the owner
 *   is the per-camera assignment when one exists, else the hub (slice 1: the
 *   stream-broker is hub-only, so the hub dials every camera).
 *
 * - `selectRunnerFrameSource`: WHAT `frameSource` the attach payload carries
 *   for a given target node. `local-broker` unless (owner modeled AND target
 *   is a different node AND the target is remote-sourcing-authorized) — the
 *   remote leg is NEVER emitted for a node the rollout knob did not
 *   authorize, even if a caller slips one past eligibility.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveRemoteSourcingNodes,
  resolveSourceOwner,
  selectRunnerFrameSource,
} from '../source-owner.js'

describe('deriveRemoteSourcingNodes (Phase-1 activation)', () => {
  it('is every decode-enabled node EXCEPT the hub (the owner)', () => {
    expect(
      deriveRemoteSourcingNodes(['hub', 'agent-a', 'MacMiniAgent.localdomain'], 'hub'),
    ).toEqual(['agent-a', 'MacMiniAgent.localdomain'])
  })

  it('rollout-off: hub is the only decode node → empty (no cross-node leg)', () => {
    expect(deriveRemoteSourcingNodes(['hub'], 'hub')).toEqual([])
  })

  it('preserves input order and never mutates its input', () => {
    const input = ['agent-b', 'hub', 'agent-a']
    const out = deriveRemoteSourcingNodes(input, 'hub')
    expect(out).toEqual(['agent-b', 'agent-a'])
    expect(input).toEqual(['agent-b', 'hub', 'agent-a'])
  })

  it('includes the hub when the owner is an agent (owner-exclusion, not hub-exclusion)', () => {
    expect(deriveRemoteSourcingNodes(['hub', 'agent-a'], 'agent-a')).toEqual(['hub'])
  })

  it('excludes the hub when the hub is the owner (identical to pre-slice behavior)', () => {
    expect(deriveRemoteSourcingNodes(['hub', 'agent-a'], 'hub')).toEqual(['agent-a'])
  })

  it('is empty when the owner is the only decode node', () => {
    expect(deriveRemoteSourcingNodes(['hub'], 'hub')).toEqual([])
  })
})

describe('resolveSourceOwner (P2d)', () => {
  it('rollout OFF (empty remoteSourcingNodes) → ownership unmodeled (undefined), even with an assignment', () => {
    expect(resolveSourceOwner({ ownerNodeId: 'hub', remoteSourcingNodes: [] })).toBeUndefined()
    expect(
      resolveSourceOwner({
        ownerNodeId: 'hub',
        remoteSourcingNodes: [],
        assignedOwner: 'agent-a',
      }),
    ).toBeUndefined()
  })

  it('rollout ON → the cluster ingest owner owns every camera by default', () => {
    expect(resolveSourceOwner({ ownerNodeId: 'hub', remoteSourcingNodes: ['agent-a'] })).toBe('hub')
  })

  it('rollout ON with an AGENT ingest owner → that agent owns every camera (ingest-off-hub)', () => {
    expect(resolveSourceOwner({ ownerNodeId: 'agent-a', remoteSourcingNodes: ['hub'] })).toBe(
      'agent-a',
    )
  })

  it('rollout ON → a per-camera assignment wins over the cluster default (slice-2 seam)', () => {
    expect(
      resolveSourceOwner({
        ownerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
        assignedOwner: 'agent-b',
      }),
    ).toBe('agent-b')
  })
})

describe('selectRunnerFrameSource (P2d)', () => {
  it('ownership unmodeled (rollout OFF) → local-broker for every target', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: undefined,
        remoteSourcingNodes: [],
      }),
    ).toEqual({ kind: 'local-broker' })
  })

  it('target IS the owner → local-broker (today’s co-located path)', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'hub',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
      }),
    ).toEqual({ kind: 'local-broker' })
  })

  it('target ≠ owner AND remote-sourcing-authorized → remote-restream naming the owner', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
      }),
    ).toEqual({ kind: 'remote-restream', ownerNodeId: 'hub' })
  })

  it('target ≠ owner but NOT authorized → local-broker (never emit an unauthorized remote leg)', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-b',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
      }),
    ).toEqual({ kind: 'local-broker' })
  })

  it('carries the operator hostname override into the remote leg', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
        hubHostnameOverride: '192.168.x.x',
      }),
    ).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      hubHostnameOverride: '192.168.x.x',
    })
  })

  it('carries the resolved ownerReachableHost into the remote leg', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
        ownerReachableHost: '192.168.x.x',
      }),
    ).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      ownerReachableHost: '192.168.x.x',
    })
  })

  it('carries BOTH ownerReachableHost and the operator override when present', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
        ownerReachableHost: '192.168.x.x',
        hubHostnameOverride: '10.x.x.x',
      }),
    ).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      ownerReachableHost: '192.168.x.x',
      hubHostnameOverride: '10.x.x.x',
    })
  })

  it('omits ownerReachableHost when unset (unchanged shape)', () => {
    expect(
      selectRunnerFrameSource({
        targetNodeId: 'agent-a',
        sourceOwnerNodeId: 'hub',
        remoteSourcingNodes: ['agent-a'],
      }),
    ).toEqual({ kind: 'remote-restream', ownerNodeId: 'hub' })
  })
})
