/**
 * A location's capacity is a measurement OF ITS OWN VOLUME, or it is unknown.
 *
 * The defect this pins, measured on the live hub on 2026-09-13:
 * `storage.listLocations` returned two `backups` locations — one
 * `filesystem-storage` at `/data/backups`, one `smb-storage` on
 * `//192.168.10.89/backups` with `basePath: "camstack"` — carrying
 * BYTE-IDENTICAL capacity (`total 506107977728`, `available 193348673536`).
 * `owned` differed correctly (9.9 GB vs 1.6 GB), so it was not a rendering
 * coincidence: the probe `path.resolve`d the share-relative `"camstack"`
 * against the hub's own cwd, found nothing there, walked up to an existing
 * ancestor and `statfs`'d the HUB's root volume. The Storage page then told
 * the operator the SMB share was 62% full on a reading nobody took of it.
 */
import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  freePercentOf,
  readLocalVolumeCapacity,
  volumeTotalBytesOf,
  type VolumeProbe,
} from '../location-volume-capacity.js'

interface FakeVolume {
  readonly blocks: number
  readonly bsize: number
  readonly bavail: number
}

/** A fake filesystem: which paths exist, and what volume each one sits on. */
function probeOf(volumes: Readonly<Record<string, FakeVolume>>): VolumeProbe {
  return {
    access: async (p: string) => {
      if (!(p in volumes)) throw new Error(`ENOENT: ${p}`)
    },
    statfs: async (p: string) => {
      const v = volumes[p]
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
  }
}

/** The hub's own root volume — the one the defect handed to the SMB share. */
const HUB_ROOT: FakeVolume = { blocks: 123561518, bsize: 4096, bavail: 47204852 }

function location(overrides: Partial<StorageLocation>): StorageLocation {
  const now = 1_789_000_000_000
  return {
    id: 'backups:default',
    type: 'backups',
    displayName: 'Backups',
    providerId: 'filesystem-storage',
    config: { basePath: '/data/backups' },
    nodeId: 'hub',
    isSystem: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** The live `backups:smb` row, verbatim minus the secrets. */
const SMB_LOCATION: StorageLocation = location({
  id: 'backups:smb',
  displayName: 'SMB',
  providerId: 'smb-storage',
  config: { host: '192.168.10.89', share: 'backups', basePath: 'camstack' },
  nodeId: undefined,
})

describe('capacity of a location served by a remote provider', () => {
  it('is unknown — never the hub volume the relative basePath resolved onto', async () => {
    const result = await readLocalVolumeCapacity(SMB_LOCATION, false, 'hub', {
      probe: probeOf({ '/': HUB_ROOT }),
      cwd: '/app',
    })

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.reason).toContain('smb-storage')
  })

  it('is unknown for a provider this node has not classified yet', async () => {
    const result = await readLocalVolumeCapacity(
      location({ providerId: 'not-yet-registered' }),
      undefined,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT, '/data/backups': HUB_ROOT }), cwd: '/app' },
    )

    expect(result.kind).toBe('unknown')
  })
})

describe('capacity of a node-local location', () => {
  it('is the statfs of its own path', async () => {
    const volume: FakeVolume = { blocks: 976000000, bsize: 4096, bavail: 378000000 }
    const result = await readLocalVolumeCapacity(
      location({ config: { basePath: '/media-fast/recordingsLow' } }),
      true,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT, '/media-fast/recordingsLow': volume }), cwd: '/app' },
    )

    expect(result).toEqual({
      kind: 'measured',
      path: '/media-fast/recordingsLow',
      totalBytes: volume.blocks * volume.bsize,
      availableBytes: volume.bavail * volume.bsize,
    })
  })

  it('measures the nearest existing ancestor — the volume a write would land on', async () => {
    const volume: FakeVolume = { blocks: 976000000, bsize: 4096, bavail: 378000000 }
    const result = await readLocalVolumeCapacity(
      location({ config: { basePath: '/media-fast/not-made-yet' } }),
      true,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT, '/media-fast': volume }), cwd: '/app' },
    )

    expect(result.kind).toBe('measured')
    if (result.kind !== 'measured') return
    expect(result.path).toBe('/media-fast')
  })

  it('is unknown when the walk reaches the root — the mount is gone, not empty', async () => {
    const result = await readLocalVolumeCapacity(
      location({ config: { basePath: '/media-fast/recordingsLow' } }),
      true,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT }), cwd: '/app' },
    )

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.reason).toContain('/media-fast/recordingsLow')
  })

  it('is unknown for a relative basePath, even on a node-local provider', async () => {
    const result = await readLocalVolumeCapacity(
      location({ config: { basePath: 'camstack' } }),
      true,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT, '/app': HUB_ROOT }), cwd: '/app' },
    )

    expect(result.kind).toBe('unknown')
  })

  it('is unknown for a location that lives on another node', async () => {
    const result = await readLocalVolumeCapacity(
      location({ nodeId: 'unraid-agent' }),
      true,
      'hub',
      { probe: probeOf({ '/': HUB_ROOT, '/data/backups': HUB_ROOT }), cwd: '/app' },
    )

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.reason).toContain('unraid-agent')
  })

  it('is unknown when statfs itself throws — the reason travels (D393)', async () => {
    const result = await readLocalVolumeCapacity(location({}), true, 'hub', {
      probe: {
        access: async () => undefined,
        statfs: async () => {
          throw new Error('ESTALE: stale file handle')
        },
      },
      cwd: '/app',
    })

    expect(result.kind).toBe('unknown')
    if (result.kind !== 'unknown') return
    expect(result.reason).toContain('ESTALE')
  })
})

describe('what the pressure guard is told about an unmeasurable volume', () => {
  it('is 100% free — the value that keeps the guard inert, never 0', () => {
    expect(freePercentOf(null)).toBe(100)
    expect(freePercentOf({ totalBytes: 0, availableBytes: 0 })).toBe(100)
  })

  it('is a zero byte target, so nothing is evicted on an unmade reading', () => {
    expect(volumeTotalBytesOf(null)).toBe(0)
  })

  it('is the real fraction once the volume answers', () => {
    expect(freePercentOf({ totalBytes: 1000, availableBytes: 250 })).toBe(25)
    expect(volumeTotalBytesOf({ totalBytes: 1000, availableBytes: 250 })).toBe(1000)
  })
})
