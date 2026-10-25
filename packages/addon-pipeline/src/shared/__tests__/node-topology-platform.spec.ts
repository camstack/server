/**
 * S3 — shared topology-entry platform/arch lookup (detection + audio).
 */
import { describe, expect, it } from 'vitest'
import { pickNodePlatformArch } from '../node-topology-platform.js'

const TOPOLOGY = [
  { id: 'hub', platform: 'darwin', arch: 'arm64', name: 'Hub' },
  { id: 'agent-a', platform: 'linux', arch: 'x64', name: 'Agent' },
] as const

describe('pickNodePlatformArch', () => {
  it('returns the matching node platform/arch', () => {
    expect(pickNodePlatformArch(TOPOLOGY, 'agent-a')).toEqual({
      platform: 'linux',
      arch: 'x64',
    })
  })

  it('returns an empty object for an unknown node', () => {
    expect(pickNodePlatformArch(TOPOLOGY, 'ghost')).toEqual({})
  })

  it('returns an empty object when topology is null/undefined', () => {
    expect(pickNodePlatformArch(null, 'hub')).toEqual({})
    expect(pickNodePlatformArch(undefined, 'hub')).toEqual({})
  })
})
