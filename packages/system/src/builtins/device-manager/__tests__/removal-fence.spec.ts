/**
 * The fence that keeps a removed device removed (D376).
 */
import { describe, expect, it } from 'vitest'
import { createRemovalFence } from '../removal-fence.js'

describe('removal fence', () => {
  it('fences the numeric id and the (addonId, stableId) pair of a removed device', () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 105, addonId: 'provider-reolink', stableId: 'studio-cam' })

    expect(fence.isIdFenced(105)?.stableId).toBe('studio-cam')
    expect(fence.isPairFenced('provider-reolink', 'studio-cam')?.deviceId).toBe(105)
  })

  it('does not fence anything else', () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 105, addonId: 'provider-reolink', stableId: 'studio-cam' })

    expect(fence.isIdFenced(101)).toBeNull()
    expect(fence.isPairFenced('provider-reolink', 'garden-cam')).toBeNull()
    expect(fence.isPairFenced('provider-onvif', 'studio-cam')).toBeNull()
  })

  it('expires: the fence covers a teardown race, not the life of the process', () => {
    let clock = 1_000
    const fence = createRemovalFence({ ttlMs: 100, now: () => clock })
    fence.record({ deviceId: 105, addonId: 'provider-reolink', stableId: 'studio-cam' })

    clock += 99
    expect(fence.isIdFenced(105)).not.toBeNull()
    clock += 1
    expect(fence.isIdFenced(105)).toBeNull()
    expect(fence.isPairFenced('provider-reolink', 'studio-cam')).toBeNull()
  })

  it('is lifted for an operator who re-adds the same hardware', () => {
    const fence = createRemovalFence()
    fence.record({ deviceId: 105, addonId: 'provider-reolink', stableId: 'studio-cam' })

    fence.lift('provider-reolink', 'studio-cam')

    expect(fence.isPairFenced('provider-reolink', 'studio-cam')).toBeNull()
    expect(fence.isIdFenced(105)).toBeNull()
  })
})
