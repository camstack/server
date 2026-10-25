/**
 * Is the placement root REALLY the filesystem this location was last written to?
 *
 * A recordings location is normally a mountpoint. When the disk fails to mount
 * after a reboot the mountpoint DIRECTORY still exists inside the container
 * root: `mkdir` succeeds, ffmpeg writes happily, and the footage lands on the
 * system volume — which then fills, while per-location accounting reports a
 * disk that is not there. Nothing on that path errors.
 *
 * WHY A MARKER AND NOT STATFS. `statfs` was the obvious probe and it does not
 * work here: Node's `StatFs` exposes no fsid, and the fields it does expose
 * (`type`, `bsize`, `blocks`) are neither stable across a remount nor unique
 * across two identically-sized volumes. Comparing a location's root against the
 * CONTAINER ROOT's fingerprint only catches the sub-case where the two differ
 * by size, and silently passes the one that matters most (a same-size spare).
 *
 * THE CHOSEN VARIANT — an adopt-on-first-use marker, remembered OFF the volume:
 *
 *   - `<root>/.camstack-location` holds `{ locationId, volumeId }`, the
 *     `volumeId` minted the first time the recorder ever writes there.
 *   - the same `volumeId` is remembered in the recorder's own durable store,
 *     which lives on the addon data dir — a DIFFERENT filesystem.
 *   - a marker that disagrees with the remembered id, or is MISSING while an id
 *     is remembered, means the bytes under this path are not the bytes we wrote.
 *
 * The absent-marker + nothing-remembered case ADOPTS rather than refusing: an
 * upgrade onto an existing recordings disk has no prior claim, and refusing
 * would stop every camera on the first boot after the deploy. The probe is
 * therefore inert on the first run and load-bearing from the second.
 *
 * A read that FAILS is `unreadable`, never `mismatch` (D49): a fallible read
 * must not be the gate that destroys work. The caller keeps the assignment.
 *
 * The marker's file name is dot-prefixed, so it is invisible to the hydrate
 * walk (which descends `<root>/<deviceId>/` only) and to `parseSegmentPath`
 * (digits-first layout) — same reasoning as `.rec-tmp`.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CamProfile } from '@camstack/types'
import { type RecordingsLocation, resolvePlacement } from './roots.js'

/** Marker file name, at the ROOT of a recordings location. */
export const LOCATION_MARKER_FILE = '.camstack-location'

/** What the marker file claims: which location, and which physical volume. */
export interface LocationMarker {
  readonly locationId: string
  readonly volumeId: string
}

/**
 * `ok` — marker agrees with what we remembered.
 * `adopted` — no prior claim; the volume is now claimed (nothing was wrong).
 * `mismatch` — the bytes under this root are not the bytes we wrote. LOUD.
 * `unreadable` — the root could not be read at all; decides nothing.
 */
export type VolumeProbeOutcome = 'ok' | 'adopted' | 'mismatch' | 'unreadable'

/** One probe's verdict, with everything a log line and an alert need. */
export interface VolumeProbeResult {
  readonly outcome: VolumeProbeOutcome
  readonly locationId: string
  readonly root: string
  /** The volume id the recorder remembered for this location; null when new. */
  readonly expectedVolumeId: string | null
  /** The volume id found (or minted) on disk; null when the marker is gone. */
  readonly foundVolumeId: string | null
  readonly detail: string
}

/** Filesystem surface the probe needs — injected so tests stay disk-free. */
export interface VolumeProbeDeps {
  readMarker: (root: string) => Promise<LocationMarker | null>
  writeMarker: (root: string, marker: LocationMarker) => Promise<void>
  newVolumeId: () => string
}

/**
 * Probe one location's root against the volume id the recorder remembered for
 * it. Never throws: an I/O failure is reported as `unreadable`.
 */
export async function probeLocationVolume(
  location: RecordingsLocation,
  rememberedVolumeId: string | null,
  deps: VolumeProbeDeps,
): Promise<VolumeProbeResult> {
  let marker: LocationMarker | null
  try {
    marker = await deps.readMarker(location.root)
  } catch (err: unknown) {
    return {
      outcome: 'unreadable',
      locationId: location.id,
      root: location.root,
      expectedVolumeId: rememberedVolumeId,
      foundVolumeId: null,
      detail: `marker read failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (marker === null) {
    if (rememberedVolumeId !== null) {
      return {
        outcome: 'mismatch',
        locationId: location.id,
        root: location.root,
        expectedVolumeId: rememberedVolumeId,
        foundVolumeId: null,
        detail: `no ${LOCATION_MARKER_FILE} at ${location.root}, but volume ${rememberedVolumeId} was remembered — the disk is not mounted here`,
      }
    }
    // No claim on either side: adopt. Minting the id is the only write this
    // probe ever performs, and it happens once per location per volume.
    const volumeId = deps.newVolumeId()
    try {
      await deps.writeMarker(location.root, { locationId: location.id, volumeId })
    } catch (err: unknown) {
      return {
        outcome: 'unreadable',
        locationId: location.id,
        root: location.root,
        expectedVolumeId: null,
        foundVolumeId: null,
        detail: `marker write failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return {
      outcome: 'adopted',
      locationId: location.id,
      root: location.root,
      expectedVolumeId: null,
      foundVolumeId: volumeId,
      detail: `claimed ${location.root} for ${location.id} as volume ${volumeId}`,
    }
  }

  // The marker's `locationId` is the FIRST claimer, kept for a human reading
  // the file — it is deliberately NOT compared. Locations legitimately alias
  // one root: stock `recordings:default` + `recordingsLow:default` both resolve
  // to `/recordings`, and comparing owners here failed every camera's `low`
  // profile over to the `recordings` location on the first deploy (observed
  // live, 2026-08-12: "`/recordings` is claimed by recordings:default, not
  // recordingsLow:default"). Which location OWNS a root is the alias guard's
  // question; this probe answers only "is this the same physical volume?".

  if (rememberedVolumeId === null) {
    // The disk already carries our claim and we have forgotten it (a wiped
    // addon store). Trust the disk — it is the party that holds the footage.
    return {
      outcome: 'adopted',
      locationId: location.id,
      root: location.root,
      expectedVolumeId: null,
      foundVolumeId: marker.volumeId,
      detail: `adopted existing volume ${marker.volumeId} at ${location.root}`,
    }
  }

  if (marker.volumeId !== rememberedVolumeId) {
    return {
      outcome: 'mismatch',
      locationId: location.id,
      root: location.root,
      expectedVolumeId: rememberedVolumeId,
      foundVolumeId: marker.volumeId,
      detail: `${location.root} holds volume ${marker.volumeId}, expected ${rememberedVolumeId} — the disk was swapped`,
    }
  }

  return {
    outcome: 'ok',
    locationId: location.id,
    root: location.root,
    expectedVolumeId: rememberedVolumeId,
    foundVolumeId: marker.volumeId,
    detail: `volume ${marker.volumeId} verified`,
  }
}

/**
 * Where to write instead when a location fails its volume probe: the normal
 * placement chain over every location NOT already known unusable. With N
 * locations this is a healthy sibling of the same type; with none left it is
 * the unusable location itself — a shouting recorder beats a stopped camera,
 * and refusing to record is the one outcome no operator asked for.
 *
 * `alreadyUnusable` is not an optimisation. Without it the search happily
 * returned a sibling that had ALSO failed its probe, so with two broken disks
 * every attach handed back the other one and the stored assignment flipped
 * A→B→A→B forever — one durable write and one audit row per attach, per camera,
 * per profile. Observed live on 2026-08-19 (the UD disk did not come back after
 * a reboot): 716 EACCES/min, with the ops-log ring flooded by the flapping.
 */
export function failoverForUnusableLocation(
  unusable: RecordingsLocation,
  locations: readonly RecordingsLocation[],
  profile: CamProfile,
  alreadyUnusable: ReadonlySet<string> = new Set<string>(),
): RecordingsLocation {
  const siblings = locations.filter((l) => l.id !== unusable.id && !alreadyUnusable.has(l.id))
  try {
    return resolvePlacement(siblings, profile)
  } catch {
    return unusable
  }
}

// ── Real-filesystem marker I/O ────────────────────────────────────────

/** Read `<root>/.camstack-location`; `null` when absent, THROWS on any other error. */
export async function readLocationMarker(root: string): Promise<LocationMarker | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(root, LOCATION_MARKER_FILE), 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const record: Record<string, unknown> = { ...parsed }
  const locationId = record['locationId']
  const volumeId = record['volumeId']
  if (typeof locationId !== 'string' || typeof volumeId !== 'string') return null
  return { locationId, volumeId }
}

/** Write `<root>/.camstack-location`. */
export async function writeLocationMarker(root: string, marker: LocationMarker): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, LOCATION_MARKER_FILE),
    `${JSON.stringify({ ...marker, stampedAt: Date.now() }, null, 2)}\n`,
    'utf8',
  )
}

/** Production probe surface: real files, real uuids. */
export const fsVolumeProbeDeps: VolumeProbeDeps = {
  readMarker: readLocationMarker,
  writeMarker: writeLocationMarker,
  newVolumeId: () => randomUUID(),
}
