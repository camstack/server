import { describe, expect, it } from 'vitest'
import { resolveIngestOwner } from '../ingest-owner.js'

describe('resolveIngestOwner', () => {
  it('returns the hub with no reachableHost by default', () => {
    expect(resolveIngestOwner({ ingestNode: 'hub', audioNode: 'hub' }, new Map(), ['hub'])).toEqual(
      {
        ownerNodeId: 'hub',
      },
    )
  })
  it('returns an agent owner with its reachableHost when set', () => {
    const hosts = new Map([['agent-a', '192.168.x.x']])
    expect(
      resolveIngestOwner({ ingestNode: 'agent-a', audioNode: 'hub' }, hosts, ['hub', 'agent-a']),
    ).toEqual({
      ownerNodeId: 'agent-a',
      reachableHost: '192.168.x.x',
    })
  })
  it('omits reachableHost when the owner has none registered', () => {
    expect(
      resolveIngestOwner({ ingestNode: 'agent-a', audioNode: 'hub' }, new Map(), [
        'hub',
        'agent-a',
      ]),
    ).toEqual({
      ownerNodeId: 'agent-a',
      configIssue: expect.stringMatching(/reachable/i),
    })
  })

  it('no configIssue when the hub is the owner (capable + reachable by default)', () => {
    expect(resolveIngestOwner({ ingestNode: 'hub', audioNode: 'hub' }, new Map(), ['hub'])).toEqual(
      {
        ownerNodeId: 'hub',
      },
    )
  })
  it('flags "unreachable" when an agent owner has no reachableHost', () => {
    const r = resolveIngestOwner({ ingestNode: 'agent-a', audioNode: 'hub' }, new Map(), [
      'hub',
      'agent-a',
    ])
    expect(r.ownerNodeId).toBe('agent-a')
    expect(r.configIssue).toMatch(/reachable/i)
  })
  it('flags "incapable" when a reachable agent owner lacks the ingest capability', () => {
    const hosts = new Map([['agent-a', '192.168.x.x']])
    const r = resolveIngestOwner({ ingestNode: 'agent-a', audioNode: 'hub' }, hosts, ['hub'])
    expect(r.reachableHost).toBe('192.168.x.x')
    expect(r.configIssue).toMatch(/capab/i)
  })
  it('no configIssue when a reachable, capable agent is the owner', () => {
    const hosts = new Map([['agent-a', '192.168.x.x']])
    const r = resolveIngestOwner({ ingestNode: 'agent-a', audioNode: 'hub' }, hosts, [
      'hub',
      'agent-a',
    ])
    expect(r.configIssue).toBeUndefined()
  })
})
