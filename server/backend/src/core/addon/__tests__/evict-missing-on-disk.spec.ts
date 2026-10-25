import { describe, it, expect } from 'vitest'
import { shouldEvictMissingOnDisk, type EvictionCandidate } from '../addon-registry.service'

describe('shouldEvictMissingOnDisk', () => {
  const onDisk = (...ids: string[]): ReadonlySet<string> => new Set(ids)

  it('evicts an installed addon that is no longer on disk', () => {
    const entry: EvictionCandidate = { source: 'installed', packageName: '@camstack/addon-ai' }
    expect(shouldEvictMissingOnDisk(entry, 'ai', onDisk())).toBe(true)
  })

  it('keeps an installed addon still present on disk', () => {
    const entry: EvictionCandidate = { source: 'installed', packageName: '@camstack/addon-ai' }
    expect(shouldEvictMissingOnDisk(entry, 'ai', onDisk('ai'))).toBe(false)
  })

  it('NEVER evicts a @camstack/system builtin, even when absent from onDiskIds', () => {
    // freshLoader scans addonsDir only, so builtins are never in onDiskIds.
    // This is the loki-logging regression: a deploy of an unrelated addon
    // must not unregister a builtin.
    const loki: EvictionCandidate = { source: 'installed', packageName: '@camstack/system' }
    expect(shouldEvictMissingOnDisk(loki, 'loki-logging', onDisk('ai', 'device-manager'))).toBe(
      false,
    )
  })

  it('never evicts a core-sourced entry', () => {
    const entry: EvictionCandidate = { source: 'core', packageName: 'addon-registry' }
    expect(shouldEvictMissingOnDisk(entry, 'addon-registry', onDisk())).toBe(false)
  })
})
