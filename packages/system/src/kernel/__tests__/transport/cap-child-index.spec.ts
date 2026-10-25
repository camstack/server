/**
 * The derived `(capName, deviceId?) → childId` index — D457.
 *
 * `resolveChildId` used to walk every connected child and, for each, every
 * descriptor in its cap manifest, on EVERY `cap-call-out`. A 50 s V8 profile
 * of the live hub put that scan at **7.1 % self time of hub-main's busy main
 * thread (1 259 ms)** across 39 children — larger, after D448, than all of
 * msgpack put together (D456).
 *
 * The index is a DERIVED accelerator, not a second registry (D3): it holds no
 * fact the `children` map does not hold, it is built from that map and nothing
 * else, and it is dropped whole on every mutation of it. This file's first
 * job is therefore the only thing that matters about it — **it must answer
 * exactly what the linear scan answered**, which is asserted here against a
 * reference implementation of the scan it replaces, not against a description
 * of it.
 */
import { describe, expect, it } from 'vitest'
import { buildCapChildIndex, type CapIndexEntry } from '../../transport/cap-child-index.js'
import type { ChildCapDescriptor } from '../../transport/child-cap-protocol.js'

/**
 * The ORIGINAL resolution, preserved verbatim in shape: first child owning the
 * exact `(cap, device)` pair, then every child owning a deviceId-less
 * descriptor for the cap, in children insertion order.
 */
function referenceDeviceOwner(
  entries: readonly CapIndexEntry[],
  capName: string,
  deviceId: number,
): string | null {
  for (const entry of entries) {
    if (entry.caps.some((cap) => cap.capName === capName && cap.deviceId === deviceId)) {
      return entry.childId
    }
  }
  return null
}

function referenceSingletonCandidates(
  entries: readonly CapIndexEntry[],
  capName: string,
): readonly string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.caps.some((cap) => cap.capName === capName && cap.deviceId === undefined)) {
      out.push(entry.childId)
    }
  }
  return out
}

const singleton = (capName: string): ChildCapDescriptor => ({ capName, mode: 'singleton' })
const forDevice = (capName: string, deviceId: number): ChildCapDescriptor => ({
  capName,
  mode: 'collection',
  deviceId,
})

/**
 * A fleet shaped like the hub the profile came from: several vendor providers
 * owning disjoint device subsets, several singletons, one cap owned by two
 * children (the `setActiveSingleton` case), one child declaring the same cap
 * twice, and one cap nobody owns.
 */
const FLEET: readonly CapIndexEntry[] = [
  {
    childId: 'provider-reolink',
    caps: [forDevice('ptz', 1), forDevice('ptz', 2), forDevice('snapshot', 1), singleton('vendor')],
  },
  {
    childId: 'provider-hikvision',
    caps: [forDevice('ptz', 3), forDevice('snapshot', 3), singleton('vendor')],
  },
  { childId: 'pipeline-runner', caps: [singleton('pipeline-runner'), singleton('snapshot')] },
  {
    childId: 'webrtc-a',
    caps: [singleton('webrtc-session'), singleton('webrtc-session')],
  },
  { childId: 'webrtc-b', caps: [singleton('webrtc-session')] },
]

describe('cap-child index — it answers what the linear scan answered', () => {
  const index = buildCapChildIndex(FLEET)

  it('agrees with the reference scan on every device-scoped lookup in the fleet', () => {
    const caps = ['ptz', 'snapshot', 'vendor', 'pipeline-runner', 'webrtc-session', 'absent-cap']
    for (const capName of caps) {
      for (let deviceId = 0; deviceId <= 5; deviceId += 1) {
        expect(index.deviceOwner(capName, deviceId)).toBe(
          referenceDeviceOwner(FLEET, capName, deviceId),
        )
      }
    }
  })

  it('agrees with the reference scan on every singleton candidate list', () => {
    const caps = ['ptz', 'snapshot', 'vendor', 'pipeline-runner', 'webrtc-session', 'absent-cap']
    for (const capName of caps) {
      expect([...index.singletonCandidates(capName)]).toEqual([
        ...referenceSingletonCandidates(FLEET, capName),
      ])
    }
  })

  it('keeps children insertion order in the candidate list — first-registered is first', () => {
    expect([...index.singletonCandidates('webrtc-session')]).toEqual(['webrtc-a', 'webrtc-b'])
    expect([...index.singletonCandidates('vendor')]).toEqual([
      'provider-reolink',
      'provider-hikvision',
    ])
  })

  it('names a child ONCE even when it declares the same singleton cap twice', () => {
    // `webrtc-a` declares `webrtc-session` twice. The scan it replaces used
    // `caps.some(...)`, which names the child once; a per-descriptor index
    // would name it twice and hand `candidates[0]` a duplicate.
    expect(
      [...index.singletonCandidates('webrtc-session')].filter((c) => c === 'webrtc-a'),
    ).toEqual(['webrtc-a'])
  })

  it('gives the FIRST child that owns a duplicated device pair, like the scan', () => {
    const contested: readonly CapIndexEntry[] = [
      { childId: 'first', caps: [forDevice('ptz', 9)] },
      { childId: 'second', caps: [forDevice('ptz', 9)] },
    ]
    expect(buildCapChildIndex(contested).deviceOwner('ptz', 9)).toBe('first')
  })

  it('does not answer a device lookup from a deviceId-less descriptor', () => {
    // The two tiers are separate on purpose: `resolveChildId` prefers an exact
    // device owner and only THEN falls back to a singleton. Collapsing them
    // here would make the fallback unreachable and route a wrapper cap's
    // device call to the wrong child.
    expect(buildCapChildIndex(FLEET).deviceOwner('pipeline-runner', 1)).toBeNull()
  })

  it('answers nothing for an empty fleet', () => {
    const empty = buildCapChildIndex([])
    expect(empty.deviceOwner('ptz', 1)).toBeNull()
    expect([...empty.singletonCandidates('ptz')]).toEqual([])
  })
})
