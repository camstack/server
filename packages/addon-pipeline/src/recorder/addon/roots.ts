/**
 * Storage-root resolution + boot hydrate for the recorder addon.
 *
 * Recordings live in the managed `recordings` / `recordingsLow` storage
 * locations (operator-configurable, multi-disk-ready), resolved through the
 * `storage` cap. The v2 `RecordingIndex` is hydrated by walking each location
 * root's `<deviceId>/` subtree on disk — segment paths encode start/dur/bytes,
 * so the in-memory index can never drift from disk. (We walk the filesystem
 * directly instead of `storage.list` because that cap lists only a directory's
 * IMMEDIATE children, not the `<deviceId>/<profile>/Y/M/D/H/*.m4s` tree — using
 * it dropped the entire index to ~empty on every restart/rescan; the recorder
 * already does local fs I/O for stat/move on these same roots.)
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  AddonApi,
  CamProfile,
  IScopedLogger,
  StorageLocationMode,
  StorageLocationStateSource,
} from '@camstack/types'
import {
  errMsg,
  mayReadLocation,
  mayWriteToLocation,
  modeMayWrite,
  resolveLocationMode,
} from '@camstack/types'
import type { RecordingIndex } from '../recording-index.js'
import type { WalkedHourOutcome } from './segment-hour-ledger.js'

/**
 * A resolved recordings storage location: its ref id (`<type>:<instance>`, e.g.
 * `recordings:default`), its declared `type` (`recordings` | `recordingsLow`),
 * and its absolute root path. Placement routing keys off `type`, never the id —
 * the id carries an instance suffix so a bare-string id compare never matches.
 */
export interface RecordingsLocation {
  readonly id: string
  readonly type: string
  readonly root: string
  /**
   * THE state of this location (D385), resolved ONCE at `listLocations` time by
   * the policy module — which also folds the legacy `enabled` /
   * `config.readOnly` pair for a hub that predates the field. Nothing in the
   * recorder interprets it by hand: ask `locationMayBeWritten` /
   * `locationMayBeRead`.
   */
  readonly mode: StorageLocationMode
  /**
   * DERIVED mirrors of {@link RecordingsLocation.mode}, kept readable for one
   * release so consumers that have not moved yet keep working (same transition
   * `StorageLocation.enabled` is getting). {@link recordingsLocationOfMode} is
   * the ONLY thing that writes them, which is what makes it impossible for them
   * to disagree with the mode. New code asks `locationMayBeWritten` /
   * `locationMayBeRead`.
   */
  readonly readOnly: boolean
  readonly enabled: boolean
  /**
   * Bytes this location can still absorb, when a caller measured it
   * (`min(free − minFree floor, maxUsedGb − used)`). Absent = not measured;
   * placement then falls back to a deterministic pick rather than pretending
   * to know which disk is emptier.
   */
  readonly headroomBytes?: number
  /** `config.minFreePercent` — free space this location must keep (default 10). */
  readonly minFreePercent?: number
  /** `config.maxUsedGb` — an optional cap on what recordings may occupy here. */
  readonly maxUsedGb?: number
}

/** The two recordings location types the recorder addon writes/reads. */
export const PLACEMENT_LOCATION_TYPES = ['recordings', 'recordingsLow'] as const

/** One of the two recordings CLASSES a profile is routed to. */
export type PlacementLocationType = (typeof PLACEMENT_LOCATION_TYPES)[number]

const RECORDING_LOCATION_TYPES: ReadonlySet<string> = new Set(PLACEMENT_LOCATION_TYPES)

/**
 * The recordings CLASS a profile belongs to. The one place this rule is
 * written: `resolvePlacement`, the planner's demand type and the placement
 * census must agree on it, and three copies of `profile === 'low' ? … : …` is
 * how they stop agreeing.
 */
export function placementTypeForProfile(profile: string): PlacementLocationType {
  return profile === 'low' ? 'recordingsLow' : 'recordings'
}

/** The pool placement may choose from, and whether it had to fall back. */
export interface PlacementPool {
  readonly locations: readonly RecordingsLocation[]
  /**
   * True when NOTHING is enabled and every location had to serve. The caller
   * SHOUTS about this: silently writing to a location the operator did not
   * choose is the failure mode the opt-in exists to prevent, and silently
   * writing NOWHERE is worse. The orchestrator refuses to leave a recordings
   * class with no enabled location, so this is reachable only through a
   * hand-edited store.
   */
  readonly fellBackToDisabled: boolean
}

/**
 * Narrow a resolved location list to the ones placement may write to: the
 * enabled ones — ALL of them, together. A location the operator has not opted
 * in (`enabled === false`) is still READ, age-swept and drained — it is simply
 * never a write target, exactly like a read-only one.
 *
 * When no enabled location is writable EVERY location serves instead, loudly.
 * The orchestrator refuses to leave a recordings class without an enabled
 * location, so this is reachable only through a hand-edited store — and a
 * recorder that writes nowhere is worse than one that writes under protest.
 */
export function placementPool(locations: readonly RecordingsLocation[]): PlacementPool {
  const writable = locations.filter((l) => locationMayBeWritten(l))
  if (writable.length > 0) return { locations: writable, fellBackToDisabled: false }
  // Nothing may be written. The pool degrades to what may still be READ and
  // says so, so the caller SHOUTS — and `resolvePlacement` then refuses it.
  //
  // Before D385 this promoted an `enabled: false` location to a write target
  // while a `config.readOnly` one still refused. The two are one state now
  // (`readonly`), and refusing is the half that survives: every non-`active`
  // state means the operator froze or is emptying that disk, and writing there
  // fights the relocate mover. The orchestrator refuses to leave a
  // write-serving class with no `active` location, so this is reachable only
  // through a hand-edited store.
  return { locations: locations.filter((l) => locationMayBeRead(l)), fellBackToDisabled: true }
}

/**
 * The state question, put to the ONE interpreter.
 *
 * The legacy mirrors are handed over too, so a location built by a caller that
 * has not moved to `recordingsLocationOfMode` yet is folded by the SAME rule
 * that folds an unmigrated persisted row (`mode` absent → `readOnly` → `enabled`
 * → active). There is still exactly one interpretation; the mirrors and this
 * argument disappear together next release.
 */
function stateOf(location: RecordingsLocation): StorageLocationStateSource {
  return {
    ...(location.mode !== undefined ? { mode: location.mode } : {}),
    ...(location.enabled !== undefined ? { enabled: location.enabled } : {}),
    config: location.readOnly === true ? { readOnly: true } : {},
  }
}

/** The resolved state of a location, for a message or a log line. */
export function locationMode(location: RecordingsLocation): StorageLocationMode {
  return resolveLocationMode(stateOf(location))
}

/** May the recorder write here? THE policy, never a local re-derivation. */
export function locationMayBeWritten(location: RecordingsLocation): boolean {
  return mayWriteToLocation(stateOf(location))
}

/**
 * A resolved location, with every derived mirror written from the ONE state.
 * Every `RecordingsLocation` in the recorder comes from here.
 */
export function recordingsLocationOfMode(
  base: Omit<RecordingsLocation, 'mode' | 'readOnly' | 'enabled'>,
  mode: StorageLocationMode,
): RecordingsLocation {
  return {
    ...base,
    mode,
    readOnly: !modeMayWrite(mode),
    enabled: modeMayWrite(mode),
  }
}

/** May the recorder read here? A `disabled` location may not — and that is an
 *  operator CHOICE, reported as unavailable, never as an unknown location. */
export function locationMayBeRead(location: RecordingsLocation): boolean {
  return mayReadLocation(stateOf(location))
}

/**
 * Route a recording profile to a storage location, for a (camera, profile) the
 * PLANNER has not placed yet — the first attach of a new camera, before the
 * 30 s pass runs.
 *
 * The rule, in order:
 *   1. the location's declared `type` — `low` prefers `recordingsLow`, every
 *      other profile prefers `recordings`; when the preferred type has only
 *      read-only instances, any writable recordings-type location serves;
 *   2. among those, the one with the most MEASURED headroom
 *      (`min(free − minFree floor, maxUsedGb − used)`) — the same signal the
 *      planner balances on, so the bootstrap pick and the plan agree instead of
 *      the plan having to undo the pick at the next tick;
 *   3. ties, and a pool where nothing was measured, fall to the
 *      lexicographically first id — deterministic, never "whichever came back
 *      first from the cap".
 *
 * There is no preferred instance any more (D383): every enabled location of a
 * class is a write target, and which one a camera gets is a capacity question,
 * not a flag. Throws when NO writable location exists — recording cannot start,
 * and that must be loud.
 */
export function resolvePlacement(
  locations: readonly RecordingsLocation[],
  profile: CamProfile,
): RecordingsLocation {
  if (locations.length === 0) {
    throw new Error('recorder controller: no recordings storage locations resolved')
  }
  const writable = locations.filter((l) => locationMayBeWritten(l))
  if (writable.length === 0) {
    throw new Error(
      'recorder controller: every recordings location is read-only — nowhere to write',
    )
  }
  const preferType = profile === 'low' ? 'recordingsLow' : 'recordings'
  const preferred = writable.filter((l) => l.type === preferType)
  return emptiestOf(preferred.length > 0 ? preferred : writable)
}

/** The candidate with the most measured headroom; ties (and an unmeasured
 *  pool, where every headroom is absent) by lexicographic id. */
function emptiestOf(candidates: readonly RecordingsLocation[]): RecordingsLocation {
  return candidates.toSorted((a, b) => {
    const byHeadroom = (b.headroomBytes ?? 0) - (a.headroomBytes ?? 0)
    return byHeadroom !== 0 ? byHeadroom : a.id.localeCompare(b.id)
  })[0]!
}

/**
 * Attribute a discovered segment on an aliased physical root by its profile,
 * not by whichever logical location happened to be hydrated last. Stock
 * `recordings` and `recordingsLow` deliberately share a root: high/mid belong
 * to `recordings`, while low belongs to `recordingsLow`.
 */
export function locationForHydratedProfile(
  aliases: readonly RecordingsLocation[],
  profile: string,
): RecordingsLocation {
  const preferredType = profile === 'low' ? 'recordingsLow' : 'recordings'
  const preferred = aliases
    .filter((location) => location.type === preferredType)
    .toSorted((a, b) => a.id.localeCompare(b.id))[0]
  const fallback = aliases.toSorted((a, b) => a.id.localeCompare(b.id))[0]
  if (preferred) return preferred
  if (fallback) return fallback
  throw new Error('recorder: no location aliases to attribute hydrated profile')
}

function aliasesByRoot(
  locations: readonly RecordingsLocation[],
): ReadonlyMap<string, readonly RecordingsLocation[]> {
  const grouped = new Map<string, RecordingsLocation[]>()
  for (const location of locations) {
    const aliases = grouped.get(location.root)
    if (aliases) aliases.push(location)
    else grouped.set(location.root, [location])
  }
  return grouped
}

/** One numeric key lifted out of a location's untyped `config` record, or
 *  nothing at all when it is absent or not a finite number. Absent is a real
 *  answer here: the caller falls back to a documented default, and a garbage
 *  value must never become a capacity limit. */
function numericConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  field: 'minFreePercent' | 'maxUsedGb',
): Record<string, number> {
  const raw = config[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return {}
  return { [field]: raw }
}

/**
 * Resolve every recordings storage location (`recordings` + `recordingsLow`)
 * to `{ id, root }`. Returns an empty list when the storage cap is unreachable
 * or no recordings location exists — callers degrade rather than crash.
 */
export async function resolveRecordingsLocations(
  api: AddonApi,
  logger: IScopedLogger,
): Promise<RecordingsLocation[]> {
  try {
    const locations = await api.storage.listLocations.query({})
    const recordings = locations.filter((l) => RECORDING_LOCATION_TYPES.has(l.type))
    return Promise.all(
      recordings.map(async (l) =>
        // The state, resolved ONCE by the policy module (D385). It folds the
        // legacy `enabled` / `config.readOnly` pair for a hub that has not yet
        // been migrated, so this deploys ahead of the framework train that
        // carries the field.
        recordingsLocationOfMode(
          {
            id: l.id,
            type: l.type,
            root: await api.storage.resolve.query({ location: l.id, relativePath: '' }),
            ...numericConfig(l.config, 'minFreePercent', 'minFreePercent'),
            ...numericConfig(l.config, 'maxUsedGb', 'maxUsedGb'),
          },
          resolveLocationMode(l),
        ),
      ),
    )
  } catch (err: unknown) {
    logger.warn('recorder: listLocations failed — no recordings locations resolved', {
      meta: { error: errMsg(err) },
    })
    return []
  }
}

/**
 * Hydrate the v2 `RecordingIndex` for one device from every recordings location
 * by recursively walking `<root>/<deviceId>/` for `*.m4s` segments and feeding
 * the location-relative paths (`<deviceId>/<profile>/Y/M/D/H/<file>.m4s`, which
 * `parseSegmentPath` understands) to `index.hydrateDevice`. A missing device dir
 * (no footage yet) and any per-location failure are warned + skipped
 * (best-effort), so one bad volume never blocks the rest of the hydrate.
 */
export async function hydrateDeviceFromStorage(
  _api: AddonApi,
  index: RecordingIndex,
  deviceId: number,
  locations: readonly RecordingsLocation[],
  logger: IScopedLogger,
  options: HydrateWalkOptions = {},
): Promise<void> {
  const yieldBetween = options.yieldBetween ?? macrotask
  const chunkSize = options.chunkSize ?? HYDRATE_CHUNK
  // The ledger reconcile that follows this walk PRUNES on the index's silence.
  // Announcing the walk is what lets it tell "disk no longer has this hour"
  // from "the index gave that hour back to stay inside its budget" (D524).
  index.beginWalk(deviceId)
  for (const [root, aliases] of aliasesByRoot(locations)) {
    const deviceDir = path.join(root, String(deviceId))
    const startedMs = Date.now()
    let entries: string[]
    try {
      entries = await fs.readdir(deviceDir, { recursive: true })
    } catch (err: unknown) {
      // ENOENT = the device has no footage on this location. That is still an
      // answer: replace the location's index rows with [] so a wipe cannot
      // leave ghost segments from the hour ledger as live footage.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        for (const location of aliases) index.hydrateDevice(deviceId, location.id, [])
        continue
      }
      logger.warn('recorder: hydrateDevice walk failed for location', {
        tags: { deviceId },
        meta: { locationIds: aliases.map((location) => location.id), error: errMsg(err) },
      })
      continue
    }
    const walkedMs = Date.now()

    // Resolved ONCE per profile, not once per file: it sorts the alias list
    // with `localeCompare` and there are >1M files under a device dir.
    const locationForProfile = new Map<string, string>()
    const pathsByLocation = new Map<string, string[]>()
    let handled = 0
    for (const entry of entries) {
      if (!entry.endsWith('.m4s')) continue
      const relative = `${deviceId}/${entry.split(path.sep).join('/')}`
      const profile = relative.split('/')[1] ?? ''
      let locationId = locationForProfile.get(profile)
      if (locationId === undefined) {
        locationId = locationForHydratedProfile(aliases, profile).id
        locationForProfile.set(profile, locationId)
      }
      const paths = pathsByLocation.get(locationId)
      if (paths) paths.push(relative)
      else pathsByLocation.set(locationId, [relative])
      handled += 1
      // The classify loop used to run to completion in ONE synchronous block —
      // measured at 963 ms for a single device's 544 320 entries, and the whole
      // per-device pass says nothing until every device is done. Neither is
      // acceptable next to a live write path.
      if (handled % chunkSize === 0) await yieldBetween()
    }
    for (const location of aliases) {
      if (!pathsByLocation.has(location.id)) pathsByLocation.set(location.id, [])
    }
    let indexed = 0
    const reuseBefore = index.hydrateReuseStats()
    for (const [locationId, relPaths] of pathsByLocation) {
      index.hydrateDevice(deviceId, locationId, relPaths)
      indexed += relPaths.length
    }
    const reuseAfter = index.hydrateReuseStats()
    const reused = reuseAfter.rowsReused - reuseBefore.rowsReused
    const allocated = reuseAfter.rowsAllocated - reuseBefore.rowsAllocated
    logger.info('recorder: hydrated a device from one recordings root', {
      tags: { deviceId },
      meta: {
        root,
        entries: entries.length,
        indexed,
        // A repeat walk over an unchanged archive must be almost all `reused`.
        // Every `allocated` row on a repeat walk is a path string retained a
        // SECOND time for as long as the segment lives — 69 B each, and the
        // whole archive's worth of them was 373 MB before the reuse existed.
        reused,
        allocated,
        locationIds: [...pathsByLocation.keys()],
        walkMs: walkedMs - startedMs,
        ms: Date.now() - startedMs,
      },
    })
  }
}

/** Entries classified between yields in {@link hydrateDeviceFromStorage}. */
const HYDRATE_CHUNK = 20_000

/** Pacing knobs for a device walk. Injected by tests; production takes the
 *  defaults. */
export interface HydrateWalkOptions {
  readonly yieldBetween?: () => Promise<void>
  readonly chunkSize?: number
}

/*
 * The FLEET walk (`hydrateDevicesFromStorage`) was removed on 2026-08-27 with
 * the deferred boot walk that was its only caller — see the note in
 * `addon/index.ts`. `hydrateDeviceFromStorage` (one camera, wired to
 * `rescanStorage`) and `hydrateWindowFromStorage` (one span, wired to every
 * read path) are the walks that still run.
 */

const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

/** `<deviceId>/<profile>/YYYY/MM/DD/HH` for an hour bucket (paths are UTC). */
export function hourDirRelPath(deviceId: number, profile: string, hourStartMs: number): string {
  const d = new Date(hourStartMs)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${deviceId}/${profile}/${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCHours())}`
}

const HOUR_MS = 3_600_000

/**
 * The durable hour ledger, as this walk needs it: a place to put back what the
 * listing found.
 *
 * It is a WRITE surface only. Until D523 the walk asked the ledger first and
 * served a closed hour from the row's `paths` column, which is how a row short
 * by a torn-down writer's segments became an hour the index believed complete
 * forever. The column is gone: the directory is the authority for WHICH
 * segments exist, so this walk always lists, and the ledger is only ever told
 * what the listing held.
 *
 * Structural rather than the class, so this module keeps knowing nothing about
 * SQLite, spec declaration or eviction — and so a test can hand it a stub that
 * fails.
 */
export interface HourAdoptionSink {
  /** Adopt a CLOSED hour's listing as that hour's account (creating the row if
   *  the ledger never held it) and seal it. `null` when nothing was written. */
  readonly adoptWalkedHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hourStartMs: number,
    paths: readonly string[],
  ) => Promise<WalkedHourOutcome | null>
}

/**
 * Hydrate ONLY the hours a window spans, instead of walking the archive.
 *
 * `hydrateDeviceFromStorage` is a recursive `readdir` over the whole device
 * subtree — ">1M files and takes minutes" per its own comment. Until it lands,
 * every read of past footage sees an empty index, which the server reports as
 * "no footage": measured after a deploy, a camera-day held 7 segments and grew
 * only at the rate of NEW writes for ~9 minutes.
 *
 * The path convention makes the window addressable directly: one SHALLOW
 * `readdir` per (profile, hour), ~350 entries each. A day is ~72 of them.
 *
 * Hours already walked IN THIS PROCESS are skipped, so a drag across an hour
 * costs nothing the second time.
 *
 * ## The DIRECTORY is the authority for WHICH segments exist (D523)
 *
 * This walk used to ask the durable hour ledger first and serve a closed hour
 * from the `paths` column of its row, paying one point read instead of a
 * `readdir`. That trade is gone, with the column.
 *
 * It was never safe. The row is written write-behind on every FINALIZED
 * segment, so a writer torn down mid-hour leaves segments on the array no row
 * ever mentioned; the rollover then SEALED that short row, `hydrateHour` seeded
 * the index from it, `hourSegmentsFromIndex` answered non-null — which means
 * COMPLETE — and nothing readdir'd that hour again for the life of the footage.
 * Camera 101 lost two hours off the timeline on 2026-09-17 with all 355 and 358
 * files still on the disk; camera 4374 lost 10,246 of the 10,734 `low` segments
 * of one night. D521 gated the seal. D523 removes the possibility instead: a
 * directory cannot be SHORT about itself.
 *
 * What it costs, measured on this hub: ~1 ms per hour directory of 345–349
 * files on `/recordings-2` (SATA SSD, XFS), including a directory five days
 * old. The `650 ms` five docblocks used to quote traces to a FUSE mount that
 * has been retired. D451 measured 3.6 ms cold on another camera; even there a
 * 20-day single-camera window is ~1.7 s of syscalls. CONTENTION is the real
 * ceiling, not latency — a startup warm of ~66 back-to-back reads once turned a
 * 0.2 s query into 38 s — which is why the in-process skip below carries more
 * weight than the per-call cost.
 *
 * **The live hour is always re-read** until the walk itself marks it. It is the
 * one hour whose directory can still grow, and that read is what recovers a
 * tail the previous process finalized and never persisted.
 *
 * ## …and the walk REPAIRS the account it just rebuilt
 *
 * A closed hour's listing is handed to `adoptWalkedHour`, which makes it that
 * hour's durable account and seals it
 * (`docs/design/2026-08-29-reference-nvr-recording-model.md` §4.2). The
 * difference between what the row had accounted for and what the array holds is
 * counted per camera and SAID — that number is footage that was invisible to
 * every reader until this walk.
 */
export interface HydrateWindowOptions {
  /**
   * Re-read hours this process has ALREADY walked.
   *
   * The ordinary skip is "the index says this closed hour is hydrated, and the
   * past is immutable". An export that runs inside a long-lived process and
   * must not inherit an earlier reader's view of a window asks the array again.
   * Default false: a scrub cursor walks its window per drag.
   */
  readonly verifyClosedHours?: boolean
}

export async function hydrateWindowFromStorage(
  index: RecordingIndex,
  deviceId: number,
  fromMs: number,
  toMs: number,
  locations: readonly RecordingsLocation[],
  logger: IScopedLogger,
  ledger?: HourAdoptionSink,
  options?: HydrateWindowOptions,
): Promise<void> {
  const verify = options?.verifyClosedHours === true
  if (!verify && index.hydrationOf(deviceId, fromMs, toMs) === 'hydrated') return
  const liveHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS

  for (const [root, aliases] of aliasesByRoot(locations)) {
    const deviceDir = path.join(root, String(deviceId))
    let profiles: string[]
    try {
      // Whitelist to the canonical profiles: the camera dir also hosts
      // non-profile artifacts (`events/`, and the `strips/` trees the retired
      // filmstrip tier left behind), which have no hour tree worth probing.
      profiles = (await fs.readdir(deviceDir)).filter(
        (e) => e === 'high' || e === 'mid' || e === 'low',
      )
    } catch (err: unknown) {
      // ENOENT = no footage for this device on this location — not an error.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('recorder: hydrateWindow profile listing failed', {
          tags: { deviceId },
          meta: { locationIds: aliases.map((location) => location.id), error: errMsg(err) },
        })
      }
      continue
    }

    const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS
    const reuseBefore = index.hydrateReuseStats()
    let hoursRead = 0
    let repaired = 0
    // Segments the array held that the hour's durable account did not — footage
    // that was invisible to every reader until this walk.
    let forgottenSegments = 0
    let forgottenHours = 0
    // Closed hours this walk SEALED: their account is now a listing's, so the
    // adoption sweep leaves them alone.
    let sealed = 0
    for (let hour = first; hour < toMs; hour += HOUR_MS) {
      // A CLOSED hour ALREADY WALKED IN THIS PROCESS is not re-read: the past
      // is immutable, so the directory can only return what the index already
      // holds. That is the whole skip now — it rests on this process having
      // listed the directory itself, never on a durable row's claim about it
      // (D523). The LIVE hour is always re-read until the walk marks it: that
      // read is the only thing that can recover a tail the previous process
      // finalized and never persisted.
      if (
        !verify &&
        hour < liveHour &&
        index.hydrationOf(deviceId, hour, hour + HOUR_MS) === 'hydrated'
      ) {
        continue
      }
      for (const profile of profiles) {
        const rel = hourDirRelPath(deviceId, profile, hour)
        let files: string[]
        try {
          files = await fs.readdir(path.join(root, rel))
        } catch {
          // A missing hour dir is the common case (recorder off, or that profile
          // not recorded then) — it is data, not a failure.
          continue
        }
        hoursRead += 1
        const locationId = locationForHydratedProfile(aliases, profile).id
        const relPaths = files.filter((f) => f.endsWith('.m4s')).map((f) => `${rel}/${f}`)
        index.hydrateHour(deviceId, locationId, hour, relPaths)

        // The reader repairs the durable account it just rebuilt
        // (`docs/design/2026-08-29-reference-nvr-recording-model.md` §4.2),
        // and SEALS it. Only for a CLOSED hour — a live hour's directory races
        // its writer, so a listing of it is a lower bound. The difference
        // between what the row accounted for and what the array holds is
        // counted per camera.
        if (ledger === undefined || relPaths.length === 0 || hour + HOUR_MS > Date.now()) continue
        const outcome = await ledger.adoptWalkedHour(deviceId, profile, locationId, hour, relPaths)
        if (outcome === null) continue
        if (outcome.created) repaired += 1
        else if (outcome.added > 0) {
          forgottenSegments += outcome.added
          forgottenHours += 1
        }
        if (outcome.sealedNow) sealed += 1
      }
    }
    // Mark the SPAN walked even where no hour dir existed: we looked, and the
    // absence is now a known gap rather than an unknown one.
    index.markHydrated(deviceId, fromMs, toMs)
    // Its OWN line, before the `hoursRead === 0` exit and unconditional on it:
    // footage that was invisible to every reader is not a detail of a
    // bookkeeping line, and a verified walk that found nothing missing must be
    // distinguishable from one that never ran. `warn`, because a short account
    // is a camera whose archive was under-reported until now.
    if (verify || forgottenSegments > 0) {
      const message = 'recorder: verified the hour ledger against the array'
      const entry = {
        tags: { deviceId },
        meta: { root, hoursRead, forgottenSegments, forgottenHours, sealed, verify },
      }
      if (forgottenSegments > 0) logger.warn(message, entry)
      else logger.info(message, entry)
    }
    if (hoursRead === 0) continue
    const reuseAfter = index.hydrateReuseStats()
    const reused = reuseAfter.rowsReused - reuseBefore.rowsReused
    const allocated = reuseAfter.rowsAllocated - reuseBefore.rowsAllocated
    // This is the hydrate path that actually runs on this deployment — the
    // full-archive walk is skipped (`reason=on-demand-windows`). An hour a
    // previous read already walked must come back as `reused`; every
    // `allocated` row here is a path string retained a SECOND time for the
    // segment's whole life.
    logger.info('recorder: hydrated a window from one recordings root', {
      tags: { deviceId },
      // `repaired` is how many closed hours the ledger had never accounted for
      // at all. `sealed` is how many closed hours this walk vouched for, so the
      // adoption sweep never lists them again.
      meta: { root, hoursRead, repaired, sealed, reused, allocated },
    })
  }
}
