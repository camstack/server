import { describe, it, expect } from 'vitest'
import { resolveSessionDecodeHostname, resolveSessionDecodeOwnerNodeId } from '../index.js'
import type { RunnerFrameSource } from '@camstack/types'

/**
 * Point 3 (cross-node): the session-decode worker must dial the SOURCE owner's
 * host, not `127.0.0.1`, when the camera's source is on a remote node. This
 * mirrors `remoteSourceFor`/`RemoteSourcePlane`'s hostname resolution.
 */
describe('resolveSessionDecodeHostname', () => {
  const local: RunnerFrameSource = { kind: 'local-broker' }

  it('returns undefined for a node-local (local-broker) source → broker uses 127.0.0.1', () => {
    expect(
      resolveSessionDecodeHostname({ frameSource: local }, 'https://192.168.x.x:4443'),
    ).toBeUndefined()
  })

  it('returns undefined when no frameSource is set (defaults to local)', () => {
    expect(
      resolveSessionDecodeHostname({ frameSource: undefined }, 'https://192.168.x.x:4443'),
    ).toBeUndefined()
  })

  it('uses the explicit hubHostnameOverride for a remote-restream source (override wins over hub url)', () => {
    const remote: RunnerFrameSource = {
      kind: 'remote-restream',
      ownerNodeId: 'agent-a',
      hubHostnameOverride: '192.168.x.x',
    }
    expect(resolveSessionDecodeHostname({ frameSource: remote }, 'https://192.168.x.x:4443')).toBe(
      '192.168.x.x',
    )
  })

  it('prefers the orchestrator-resolved ownerReachableHost over everything else', () => {
    const remote: RunnerFrameSource = {
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      ownerReachableHost: '10.x.x.x',
      hubHostnameOverride: '192.168.x.x',
    }
    expect(resolveSessionDecodeHostname({ frameSource: remote }, 'https://192.168.x.x:4443')).toBe(
      '10.x.x.x',
    )
  })

  it('falls back to hubHostnameOverride when ownerReachableHost is absent', () => {
    const remote: RunnerFrameSource = {
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      hubHostnameOverride: '192.168.x.x',
    }
    expect(resolveSessionDecodeHostname({ frameSource: remote }, 'https://192.168.x.x:4443')).toBe(
      '192.168.x.x',
    )
  })

  it('falls back to the host extracted from CAMSTACK_HUB_URL when no override', () => {
    const remote: RunnerFrameSource = { kind: 'remote-restream', ownerNodeId: 'agent-a' }
    const host = resolveSessionDecodeHostname({ frameSource: remote }, 'https://192.168.x.x:4443')
    expect(host).toBeDefined()
    expect(host).toContain('192.168.x.x')
  })

  it('returns undefined for a remote-restream with neither override nor hub url', () => {
    const remote: RunnerFrameSource = { kind: 'remote-restream', ownerNodeId: 'agent-a' }
    expect(resolveSessionDecodeHostname({ frameSource: remote }, undefined)).toBeUndefined()
  })
})

/**
 * Point 3 (cross-node): the session-decode worker's broker calls must be pinned
 * to the SOURCE owner node when the camera's source is on a remote node. This
 * mirrors `resolveSessionDecodeHostname` but returns the ownerNodeId for nodePin
 * instead of the hostname for the restream URL.
 */
describe('resolveSessionDecodeOwnerNodeId', () => {
  const local: RunnerFrameSource = { kind: 'local-broker' }

  it('returns undefined for a node-local (local-broker) source → calls stay unpinned', () => {
    expect(resolveSessionDecodeOwnerNodeId({ frameSource: local })).toBeUndefined()
  })

  it('returns undefined when no frameSource is set (defaults to local)', () => {
    expect(resolveSessionDecodeOwnerNodeId({ frameSource: undefined })).toBeUndefined()
  })

  it('returns the ownerNodeId for a remote-restream source', () => {
    const remote: RunnerFrameSource = {
      kind: 'remote-restream',
      ownerNodeId: 'agent-a',
      hubHostnameOverride: '192.168.x.x',
    }
    expect(resolveSessionDecodeOwnerNodeId({ frameSource: remote })).toBe('agent-a')
  })

  it('returns the ownerNodeId even when ownerReachableHost is present', () => {
    const remote: RunnerFrameSource = {
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      ownerReachableHost: '10.x.x.x',
      hubHostnameOverride: '192.168.x.x',
    }
    expect(resolveSessionDecodeOwnerNodeId({ frameSource: remote })).toBe('hub')
  })
})
