/**
 * Two locations of the SAME type must not share a physical root (D389) — and
 * the three properties that decide whether this check helps or hurts.
 */
import type { PhysicalRoot } from '@camstack/types/node'
import { describe, expect, it } from 'vitest'
import type { ResolveRoot, RootCollisionCandidate } from '../location-root-collision.js'
import { findRootCollision, rootCollisionMessage } from '../location-root-collision.js'

const row = (
  id: string,
  type: string,
  basePath: string,
  nodeId?: string,
): RootCollisionCandidate => ({
  id,
  type,
  config: { basePath },
  ...(nodeId !== undefined ? { nodeId } : {}),
})

/** A fake filesystem: `links` maps a path to what realpath answers, and any
 *  path in `unresolvable` throws the way a missing/remote root does. */
function resolver(
  links: Readonly<Record<string, string>> = {},
  unresolvable: readonly string[] = [],
): ResolveRoot {
  return (basePath): PhysicalRoot => {
    if (unresolvable.includes(basePath)) return { key: basePath, resolved: false }
    return { key: links[basePath] ?? basePath, resolved: true }
  }
}

describe('same type, same root — refused', () => {
  it('refuses two recordings locations on one directory', () => {
    const verdict = findRootCollision(
      row('recordings:second', 'recordings', '/mnt/disk'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver(),
    )
    expect(verdict.outcome).toBe('collides')
    if (verdict.outcome !== 'collides') return
    expect(verdict.collision.otherId).toBe('recordings:default')
    expect(verdict.collision.kind).toBe('equal')
    // The message names the sibling and the shared root — a refusal that says
    // only "conflict" makes the operator hunt.
    const message = rootCollisionMessage('recordings:second', verdict.collision)
    expect(message).toContain('recordings:default')
    expect(message).toContain('/mnt/disk')
  })

  it('catches a SYMLINKED alias — the case a string comparison misses', () => {
    const verdict = findRootCollision(
      row('recordings:alias', 'recordings', '/mnt/link'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver({ '/mnt/link': '/mnt/disk' }),
    )
    expect(verdict.outcome).toBe('collides')
  })
})

describe('different types on one root — allowed, on purpose', () => {
  it('recordings and recordingsLow share a root by design (D327)', () => {
    const verdict = findRootCollision(
      row('recordingsLow:default', 'recordingsLow', '/mnt/disk'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver(),
    )
    expect(verdict.outcome).toBe('clear')
  })
})

describe('containment, both directions — refused', () => {
  it('refuses a location NESTED inside an existing one of the same type', () => {
    const verdict = findRootCollision(
      row('recordings:inner', 'recordings', '/mnt/disk/sub'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver(),
    )
    expect(verdict.outcome).toBe('collides')
    if (verdict.outcome !== 'collides') return
    expect(verdict.collision.kind).toBe('nested')
  })

  it('refuses a location that CONTAINS an existing one of the same type', () => {
    const verdict = findRootCollision(
      row('recordings:outer', 'recordings', '/mnt/disk'),
      [row('recordings:inner', 'recordings', '/mnt/disk/sub')],
      resolver(),
    )
    expect(verdict.outcome).toBe('collides')
    if (verdict.outcome !== 'collides') return
    expect(verdict.collision.kind).toBe('nested')
  })

  it('a SIBLING with a shared string prefix is not containment', () => {
    // `/mnt/disk1` is not inside `/mnt/disk`, though a `startsWith` says so.
    const verdict = findRootCollision(
      row('recordings:second', 'recordings', '/mnt/disk1'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver(),
    )
    expect(verdict.outcome).toBe('clear')
  })
})

describe('"they collide" is not "I cannot tell"', () => {
  it('an unresolvable root is UNKNOWN — the write goes through', () => {
    const verdict = findRootCollision(
      row('recordings:remote', 'recordings', '/mnt/disk'),
      [row('recordings:default', 'recordings', '/mnt/disk')],
      resolver({}, ['/mnt/disk']),
    )
    // Same path, same type — and still not a refusal, because nothing was
    // actually read. A fallible read is not the gate (D49).
    expect(verdict.outcome).toBe('unknown')
  })

  it('an unresolvable SIBLING is skipped, not treated as a match', () => {
    const verdict = findRootCollision(
      row('recordings:new', 'recordings', '/mnt/disk'),
      [row('recordings:remote', 'recordings', '/mnt/other')],
      resolver({}, ['/mnt/other']),
    )
    expect(verdict.outcome).toBe('clear')
  })

  it('a location on ANOTHER NODE never collides, however identical the path', () => {
    const verdict = findRootCollision(
      row('recordings:mac', 'recordings', '/mnt/disk', 'mac-mini'),
      [row('recordings:default', 'recordings', '/mnt/disk', 'hub')],
      resolver(),
    )
    expect(verdict.outcome).toBe('clear')
  })

  it('a provider with no basePath (S3, WebDAV) has no root to share', () => {
    const verdict = findRootCollision(
      { id: 'backups:s3', type: 'backups', config: { bucket: 'x' } },
      [row('backups:default', 'backups', '/mnt/disk')],
      resolver(),
    )
    expect(verdict.outcome).toBe('clear')
  })
})

describe('editing a location does not refuse itself', () => {
  it('re-saving the same row without moving its root is clear', () => {
    const existing = row('recordings:default', 'recordings', '/mnt/disk')
    const verdict = findRootCollision(
      { ...existing, config: { basePath: '/mnt/disk', minFreePercent: 20 } },
      [existing],
      resolver(),
      existing,
    )
    expect(verdict.outcome).toBe('clear')
  })

  it('a PRE-EXISTING collision stays editable — the operator must be able to fix it', () => {
    // Two same-type rows on one root, created before this check existed (the
    // recorder has already demoted one). Refusing every edit to them would
    // leave the operator unable to re-point or disable the location they need
    // to fix — the check would have made the problem permanent.
    const stored = row('recordings:second', 'recordings', '/mnt/disk')
    const verdict = findRootCollision(
      { ...stored, config: { basePath: '/mnt/disk', minFreePercent: 25 } },
      [row('recordings:default', 'recordings', '/mnt/disk'), stored],
      resolver(),
      stored,
    )
    expect(verdict.outcome).toBe('clear')
  })

  it('but MOVING that row onto another same-type root is still refused', () => {
    const stored = row('recordings:second', 'recordings', '/mnt/disk')
    const verdict = findRootCollision(
      { ...stored, config: { basePath: '/mnt/other' } },
      [row('recordings:default', 'recordings', '/mnt/other'), stored],
      resolver(),
      stored,
    )
    expect(verdict.outcome).toBe('collides')
  })
})
