/**
 * The volume probe: is the placement root REALLY the filesystem this location
 * was last written to?
 *
 * A recordings location is normally a mountpoint. When the disk fails to mount
 * after a reboot the mountpoint DIRECTORY still exists inside the container
 * root, `mkdir` succeeds, ffmpeg writes happily — and the footage lands on the
 * system volume, which then fills. Nothing about that path errors.
 *
 * Cheap honest variant chosen (statfs fingerprinting was rejected: Node's
 * `statfs` exposes no fsid, and `type`/`blocks` are neither stable across
 * remounts nor unique across identical volumes):
 *
 *   an ADOPT-ON-FIRST-USE MARKER FILE, remembered OFF the volume.
 *
 * `<root>/.camstack-location` names the location and a `volumeId` minted the
 * first time the recorder ever writes there; the same `volumeId` is remembered
 * in the recorder's own durable store, which lives on a different filesystem.
 * A marker that disagrees with the remembered id — or is MISSING while an id is
 * remembered — means the bytes under this path are not the bytes we wrote.
 *
 * The absent+absent case ADOPTS rather than refusing: an upgrade onto an
 * existing recordings disk has no prior claim, and refusing would stop every
 * camera on the first boot after the deploy.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  failoverForUnusableLocation,
  type LocationMarker,
  probeLocationVolume,
  type VolumeProbeDeps,
} from '../addon/placement-volume.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

const LOC: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/mnt/rec' },
  'active',
)

interface ProbeHarness {
  readonly deps: VolumeProbeDeps
  readonly written: LocationMarker[]
}

function harness(marker: LocationMarker | null): ProbeHarness {
  const written: LocationMarker[] = []
  return {
    written,
    deps: {
      readMarker: vi.fn(async () => marker),
      writeMarker: vi.fn(async (_root: string, m: LocationMarker) => {
        written.push(m)
      }),
      newVolumeId: () => 'vol-new',
    },
  }
}

describe('probeLocationVolume', () => {
  it('adopts a root with no marker and nothing remembered — the upgrade path', async () => {
    const h = harness(null)
    const result = await probeLocationVolume(LOC, null, h.deps)

    expect(result.outcome).toBe('adopted')
    expect(result.foundVolumeId).toBe('vol-new')
    expect(h.written).toEqual([{ locationId: 'recordings:default', volumeId: 'vol-new' }])
  })

  it('adopts the marker already on disk when nothing is remembered yet', async () => {
    const h = harness({ locationId: 'recordings:default', volumeId: 'vol-a' })
    const result = await probeLocationVolume(LOC, null, h.deps)

    expect(result.outcome).toBe('adopted')
    expect(result.foundVolumeId).toBe('vol-a')
    // The disk already had a claim — do not overwrite it.
    expect(h.written).toEqual([])
  })

  it('passes when the marker matches what was remembered', async () => {
    const h = harness({ locationId: 'recordings:default', volumeId: 'vol-a' })
    const result = await probeLocationVolume(LOC, 'vol-a', h.deps)

    expect(result.outcome).toBe('ok')
    expect(h.written).toEqual([])
  })

  it('MISMATCHES when the marker is gone but a volume was remembered (the unmounted disk)', async () => {
    const h = harness(null)
    const result = await probeLocationVolume(LOC, 'vol-a', h.deps)

    expect(result.outcome).toBe('mismatch')
    expect(result.expectedVolumeId).toBe('vol-a')
    expect(result.foundVolumeId).toBeNull()
    // Never re-stamp a volume we do not recognise: that would launder the fault.
    expect(h.written).toEqual([])
  })

  it('MISMATCHES when the marker names a different volume (the swapped disk)', async () => {
    const h = harness({ locationId: 'recordings:default', volumeId: 'vol-b' })
    const result = await probeLocationVolume(LOC, 'vol-a', h.deps)

    expect(result.outcome).toBe('mismatch')
    expect(result.foundVolumeId).toBe('vol-b')
  })

  it('does NOT mismatch on a marker written by an ALIAS of the same root', async () => {
    // Stock `recordings:default` and `recordingsLow:default` both resolve to
    // `/recordings`. Comparing the marker's OWNER failed every camera's `low`
    // profile over to the `recordings` location on the first live deploy
    // (2026-08-12). The probe answers "is this the same physical volume?" —
    // which location owns a root is the alias guard's question.
    const h = harness({ locationId: 'recordings:other', volumeId: 'vol-a' })
    const result = await probeLocationVolume(LOC, 'vol-a', h.deps)

    expect(result.outcome).toBe('ok')
    expect(h.written).toEqual([])
  })

  it('still MISMATCHES an alias marker whose VOLUME disagrees', async () => {
    const h = harness({ locationId: 'recordings:other', volumeId: 'vol-b' })
    const result = await probeLocationVolume(LOC, 'vol-a', h.deps)
    expect(result.outcome).toBe('mismatch')
  })

  it('an unreadable root is UNREADABLE, never a mismatch — a read that fails changes nothing (D49)', async () => {
    const deps: VolumeProbeDeps = {
      readMarker: vi.fn(async () => {
        throw new Error('EIO')
      }),
      writeMarker: vi.fn(async () => undefined),
      newVolumeId: () => 'vol-new',
    }
    const result = await probeLocationVolume(LOC, 'vol-a', deps)
    expect(result.outcome).toBe('unreadable')
  })
})

describe('failoverForUnusableLocation', () => {
  const sibling: RecordingsLocation = recordingsLocationOfMode(
    { id: 'recordings:ssd', type: 'recordings', root: '/mnt/ssd' },
    'active',
  )
  const low: RecordingsLocation = recordingsLocationOfMode(
    { id: 'recordingsLow:nas', type: 'recordingsLow', root: '/mnt/nas' },
    'active',
  )

  it('fails the assignment over to a writable sibling of the same type', () => {
    expect(failoverForUnusableLocation(LOC, [LOC, sibling, low], 'high')).toBe(sibling)
  })

  it('falls through the normal placement chain when no same-type sibling exists', () => {
    expect(failoverForUnusableLocation(LOC, [LOC, low], 'high')).toBe(low)
  })

  it('KEEPS the unusable location when it is the only one — a shouting recorder beats a stopped camera', () => {
    expect(failoverForUnusableLocation(LOC, [LOC], 'high')).toBe(LOC)
  })
})
