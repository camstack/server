/**
 * `resolveBrokerTier` is the pure lookup behind `StreamBrokerManager`'s
 * `profileTierResolver` closure (wired via `setWebrtcServer` →
 * `server.setProfileTierResolver`). Slice 3b Task 2: a remote-owned camera's
 * WebRTC adapter has no entry in `this.assignments` (that map only tracks
 * LOCALLY-owned devices), so the local lookup always returns null for it —
 * `remoteBrokerTiers` is the fallback populated at the remote-adapter ensure
 * site (Task 3) so `selectBestBroker` can still tier-match it.
 *
 * Precedence: local wins when both resolve a tier for the same brokerId —
 * a local broker should never be shadowed by a stale remote-tier entry.
 */
import { describe, it, expect } from 'vitest'
import { resolveBrokerTier } from '../stream-broker/stream-broker-manager.js'
import type { CamProfile } from '@camstack/types'

describe('resolveBrokerTier', () => {
  const alwaysNullLocal = (): CamProfile | null => null

  it('resolves the tier from remoteBrokerTiers when the local lookup misses', () => {
    const remoteBrokerTiers = new Map<string, CamProfile>([['9/native:main', 'mid']])
    expect(resolveBrokerTier('9/native:main', alwaysNullLocal, remoteBrokerTiers)).toBe('mid')
  })

  it('prefers the local lookup when both local and remote resolve a tier', () => {
    const remoteBrokerTiers = new Map<string, CamProfile>([['9/native:main', 'mid']])
    const localLookup = (): CamProfile | null => 'high'
    expect(resolveBrokerTier('9/native:main', localLookup, remoteBrokerTiers)).toBe('high')
  })

  it('returns null when the brokerId is absent from both local and remote', () => {
    const remoteBrokerTiers = new Map<string, CamProfile>()
    expect(resolveBrokerTier('9/native:main', alwaysNullLocal, remoteBrokerTiers)).toBeNull()
  })
})
