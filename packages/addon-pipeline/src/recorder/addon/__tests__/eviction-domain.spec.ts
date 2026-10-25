import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { physicalRootKey, resolveEvictionDomain } from '../eviction-domain.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'

describe('eviction-domain', () => {
  describe('physicalRootKey', () => {
    it('resolves `.`/`..` segments lexically before realpath', () => {
      // Injected realpath is identity → key is purely the resolved path.
      const key = physicalRootKey('/recordings/../recordings/./sub', (p) => p)
      expect(key).toBe('/recordings/sub')
    })

    it('falls back to the resolved path string when realpath throws', () => {
      const throwing = (): string => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      // Root missing at boot (disk not mounted) → resolved string, not a crash.
      expect(physicalRootKey('/mnt/../mnt/notmounted', throwing)).toBe('/mnt/notmounted')
    })
  })

  describe('resolveEvictionDomain (string roots)', () => {
    it('groups two aliases that share one lexical root into one domain', () => {
      const locations: RecordingsLocation[] = [
        recordingsLocationOfMode(
          { id: 'recordings:default', type: 'recordings', root: '/recordings' },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'recordingsLow:default', type: 'recordingsLow', root: '/recordings' },
          'active',
        ),
      ]
      const domain = resolveEvictionDomain(locations, 'recordings:default', (p) => p)
      expect([...domain].toSorted()).toEqual(['recordings:default', 'recordingsLow:default'])
    })

    it('keeps distinct roots in distinct domains', () => {
      const locations: RecordingsLocation[] = [
        recordingsLocationOfMode(
          { id: 'a:default', type: 'recordings', root: '/disk-a' },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'b:default', type: 'recordings', root: '/disk-b' },
          'active',
        ),
      ]
      const domain = resolveEvictionDomain(locations, 'a:default', (p) => p)
      expect([...domain]).toEqual(['a:default'])
    })

    it('returns a singleton for an unknown locationId', () => {
      const locations: RecordingsLocation[] = [
        recordingsLocationOfMode(
          { id: 'a:default', type: 'recordings', root: '/disk-a' },
          'active',
        ),
      ]
      const domain = resolveEvictionDomain(locations, 'ghost:default', (p) => p)
      expect([...domain]).toEqual(['ghost:default'])
    })

    it('keeps roots that only differ by symlink in DISTINCT domains when realpath throws (safe fallback)', () => {
      // realpath unavailable → fall back to lexical strings; the two aliases
      // then look distinct. Over-partitioning is the safe failure mode.
      const throwing = (): string => {
        throw new Error('boom')
      }
      const locations: RecordingsLocation[] = [
        recordingsLocationOfMode(
          { id: 'real:default', type: 'recordings', root: '/recordings' },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'link:default', type: 'recordings', root: '/recordings-link' },
          'active',
        ),
      ]
      const domain = resolveEvictionDomain(locations, 'real:default', throwing)
      expect([...domain]).toEqual(['real:default'])
    })
  })

  describe('resolveEvictionDomain (real tmpdir + symlink)', () => {
    let base: string
    let realDir: string
    let linkDir: string

    beforeAll(() => {
      base = mkdtempSync(path.join(realpathSync(tmpdir()), 'evict-domain-'))
      realDir = path.join(base, 'recordings')
      linkDir = path.join(base, 'recordings-alias')
      mkdirSync(realDir)
      symlinkSync(realDir, linkDir)
    })

    afterAll(() => {
      rmSync(base, { recursive: true, force: true })
    })

    it('merges a real dir and a symlink pointing at it into one domain (default realpathSync)', () => {
      const locations: RecordingsLocation[] = [
        recordingsLocationOfMode(
          { id: 'recordings:default', type: 'recordings', root: realDir },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'recordingsLow:default', type: 'recordingsLow', root: linkDir },
          'active',
        ),
      ]
      const domain = resolveEvictionDomain(locations, 'recordingsLow:default')
      expect([...domain].toSorted()).toEqual(['recordings:default', 'recordingsLow:default'])
    })

    it('resolves the symlink to the real dir key', () => {
      expect(physicalRootKey(linkDir)).toBe(realpathSync(realDir))
    })
  })
})
