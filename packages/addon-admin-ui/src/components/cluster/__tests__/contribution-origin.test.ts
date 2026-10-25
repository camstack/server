/**
 * Contributions arrive CLUSTER-WIDE and every number built on a pid is only
 * true within one node.
 *
 * The failure this file exists to prevent is specific and silent: the hub runs
 * a claimed process with pid 100, an agent runs an unclaimed one with pid 100,
 * and a cluster-wide claim set applied to the agent's process snapshot reports
 * the agent's process as owned. Nothing errors. The one finding this whole
 * surface produces — "a process nobody knows about" — is deleted, and the
 * coverage pair reads 47 of 47 while a leak runs.
 */
import { describe, expect, it } from 'vitest'
import {
  bareAddonId,
  contributionsOnNode,
  isFromNode,
  splitProviderKey,
  type NodeScope,
} from '../load/contribution-origin'
import { foldContributionsByCamera, type CameraLoadEntry } from '../load/camera-load-fold'

const HUB: NodeScope = { nodeId: 'hub-main', isHub: true }
const AGENT: NodeScope = { nodeId: 'agent-a', isHub: false }

function entry(addonId: string, pid: number): CameraLoadEntry {
  return {
    addonId,
    role: 'recording',
    deviceId: 101,
    attribution: 'measured',
    unit: '101/high',
    pid,
    startedAtMs: 1,
    cpuSeconds: 1,
    rssBytes: 1,
  }
}

describe('the registry key says which node a contribution came from', () => {
  it('reads a bare key as the hub — the rule the registry itself writes', () => {
    expect(splitProviderKey('recorder')).toEqual({ addonId: 'recorder', nodeId: null })
  })

  it('reads an @-suffixed key as that agent', () => {
    expect(splitProviderKey('recorder@agent-a')).toEqual({
      addonId: 'recorder',
      nodeId: 'agent-a',
    })
  })

  it('splits on the FIRST @, the same as CapabilityRegistry.nodeOfKey', () => {
    // Two functions that split the same key differently is how one provider
    // ends up counted on two nodes.
    expect(splitProviderKey('a@b@c').nodeId).toBe('b@c')
    expect(bareAddonId('recorder@agent-a')).toBe('recorder')
  })

  it('resolves a bare key to the hub and to no agent', () => {
    expect(isFromNode('recorder', HUB)).toBe(true)
    expect(isFromNode('recorder', AGENT)).toBe(false)
    expect(isFromNode('recorder@agent-a', AGENT)).toBe(true)
    expect(isFromNode('recorder@agent-a', HUB)).toBe(false)
  })
})

describe('an unclaimed process is never covered by a claim on another node', () => {
  const clusterWide = [entry('recorder', 100), entry('recorder@agent-a', 100)]
  // Both nodes happen to run a process numbered 100, and only one of the two
  // is what the agent's snapshot is showing.
  const agentProcesses = [
    { pid: 100, memoryRssBytes: 50_000_000 },
    { pid: 777, memoryRssBytes: 7_000_000 },
  ]

  it('narrows the cluster-wide list to THIS node’s claims only', () => {
    const scoped = contributionsOnNode(clusterWide, AGENT)
    expect(scoped).toHaveLength(1)
  })

  it('keeps the process nobody claimed in its OWN bucket', () => {
    const scoped = contributionsOnNode(clusterWide, AGENT)
    const buckets = foldContributionsByCamera(scoped, agentProcesses)
    const unclaimed = buckets.find((b) => b.kind === 'unclaimed')
    expect(unclaimed?.unitCount).toBe(1)
    expect(unclaimed?.rssBytes).toBe(7_000_000)
    // And it is NOT folded into the camera that happens to be on this node.
    expect(buckets.find((b) => b.deviceId === 101)?.rssBytes).toBe(1)
  })

  it('does not let the hub absorb an agent’s claims either', () => {
    const scoped = contributionsOnNode(clusterWide, HUB)
    expect(scoped.map((e) => e.addonId)).toEqual(['recorder'])
  })
})
