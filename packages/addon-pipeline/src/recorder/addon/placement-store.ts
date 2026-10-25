/**
 * The recorder's OWN durable placement state (`recordingPlacement`).
 *
 * WHY NOT `RecordingConfigSchema`. That schema is strict, lives in
 * `@camstack/types`, and every field added to it needs a framework train before
 * the recorder can read it back. Placement is recorder-owned bookkeeping, so it
 * belongs in the recorder's own addon-store blob — exactly like
 * `recordingConfigs` (config-store.ts) and `recordingOpsLog` (ops-log-store.ts),
 * whose DurableState pattern this file copies verbatim.
 *
 * Three things live here:
 *   - `assignments` — the per-(camera, profile) → locationId assignment. The
 *     UNIT of placement: one camera's one profile writes to ONE location for a
 *     whole writer run, never striped per segment.
 *   - `pins` — operator-set `<deviceId>` → recordings locationId. A pin
 *     survives the planner: Auto is the absence of a pin.
 *   - `volumeIds` — the volume id the mount probe remembers per location. It
 *     MUST live off the volume it describes (see `placement-volume.ts`); the
 *     addon store is on the data dir, a different filesystem.
 *   - `defaultLocations` — DEAD (D383). The class default it stamped no longer
 *     exists; the key stays DECLARED so an old blob still parses (a key dropped
 *     from a non-strict object is stripped in silence, and a reader that later
 *     needs it cannot tell "absent" from "never written" — D380/D381), and
 *     nothing reads it.
 *
 * A corrupt blob reads back EMPTY rather than crashing boot. Empty means "no
 * assignment yet", which every caller already handles by planning from scratch.
 */

import type { CamProfile, DurableState } from '@camstack/types'
import { z } from 'zod'

/** The addon-store key holding the placement blob. */
export const RECORDING_PLACEMENT_KEY = 'recordingPlacement'

/**
 * Persisted shape. Both maps are plain records so an unknown key never takes
 * the whole blob down: a location that no longer exists is dropped by the
 * reader, not by the schema.
 */
export const RecordingPlacementBlobSchema = z.object({
  /** `<deviceId>:<profile>` → locationId. */
  assignments: z.record(z.string(), z.string()).default({}),
  /**
   * Operator pin: `String(deviceId)` → a `recordings:*` location id.
   * Absent = Auto. High and mid follow the pin; low is not pinned here.
   */
  pins: z.record(z.string(), z.string()).default({}),
  /** locationId → the volume id last verified at that location's root. */
  volumeIds: z.record(z.string(), z.string()).default({}),
  /**
   * DEAD KEY (D383) — the class authority a pass planned against, back when a
   * class had a default distinct from its pool. Declared so an existing blob
   * round-trips unchanged and so its removal is a decision on the record rather
   * than a silent strip. Never read, never written.
   */
  defaultLocations: z.record(z.string(), z.string()).default({}),
  /** When the blob was last written (operator-facing debugging only). */
  updatedAt: z.number().optional(),
})
export type RecordingPlacementBlob = z.infer<typeof RecordingPlacementBlobSchema>

/** Durable handle over the `recordingPlacement` blob (one store key). */
export type RecordingPlacementState = DurableState<RecordingPlacementBlob>

/** Cold-start value: nothing assigned, nothing claimed. */
export const EMPTY_PLACEMENT: RecordingPlacementBlob = {
  assignments: {},
  pins: {},
  volumeIds: {},
  defaultLocations: {},
}

/** The assignment key for one (camera, profile) pair. */
export function assignmentKey(deviceId: number, profile: CamProfile | string): string {
  return `${deviceId}:${profile}`
}

/** Read the whole placement blob (EMPTY when absent or corrupt). */
export async function readPlacementState(
  state: RecordingPlacementState,
): Promise<RecordingPlacementBlob> {
  return state.get()
}

/**
 * REPLACE the assignment map wholesale, preserving everything else in the blob.
 * The WHOLE blob round-trips on every write (the DurableState contract), so the
 * remembered volume ids and the class authority cannot be dropped by an
 * assignment write.
 *
 * `base` is REQUIRED, and it is the blob the caller already read. This used to
 * re-read the store itself, which made every write two round trips instead of
 * one — and every one of them goes over the UDS door to `hub/sqlite-settings`
 * with the 60 s default bound. The placement pass read the blob, then wrote it,
 * and paid for the read TWICE: 4 × 60 s = the `durationMs: 240003` pass measured
 * on the live hub against a 30 s budget. Taking the blob as an argument makes
 * "one plan, one read, one write" a shape the type system enforces.
 *
 * **Only a caller holding the WHOLE record may use this.** The record is
 * fleet-wide; a caller holding a work-scoped subset must use
 * {@link writePlacementPass}, because replacing a fleet-wide record from a
 * subset deletes every key the subset did not mention. That is exactly what the
 * 30 s placement pass did (D299): its work set came from the RAM index, so
 * since D287 a (camera, profile) with no resident rows was dropped from the
 * durable blob on the next tick that changed anything — and a `enabledDeviceIds`
 * timeout narrows the pass to the ACTIVE cameras, which would have dropped
 * every idle one. Hence the rename: a replace has to be typed out.
 */
export async function replaceAssignments(
  state: RecordingPlacementState,
  base: RecordingPlacementBlob,
  assignments: ReadonlyMap<string, string>,
): Promise<void> {
  const next: Record<string, string> = {}
  for (const [key, locationId] of assignments) next[key] = locationId
  await state.set({ ...base, assignments: next, updatedAt: Date.now() })
}

/**
 * What one WORK-SCOPED placement pass leaves behind.
 *
 * The pass plans a subset — the (camera, profile) pairs the controller tick is
 * converging that have footage in the archive — while the record it writes is
 * fleet-wide. The two are reconciled here, once, so no caller has to remember
 * the rule.
 */
export interface PlacementPassWrite {
  /** What this pass PLANNED — its own work set, never the fleet. Merged over
   *  the stored record. */
  readonly planned: ReadonlyMap<string, string>
}

/**
 * The assignment record a pass leaves behind: the stored one with the plan
 * merged over it. **Nothing is ever removed** — a pass that plans a subset
 * cannot delete a key it did not mention.
 *
 * PURE, and shared by the write and the placement census — a report computed
 * from a second reading of the same rule is a report that can describe a record
 * the write did not produce.
 */
export function applyPlacementPass(
  base: Readonly<Record<string, string>>,
  pass: PlacementPassWrite,
): ReadonlyMap<string, string> {
  const next = new Map(Object.entries(base))
  for (const [key, locationId] of pass.planned) next.set(key, locationId)
  return next
}

/** Persist one work-scoped pass: merge its plan over the stored record. One
 *  write. */
export async function writePlacementPass(
  state: RecordingPlacementState,
  base: RecordingPlacementBlob,
  pass: PlacementPassWrite,
): Promise<void> {
  const assignments: Record<string, string> = {}
  for (const [key, locationId] of applyPlacementPass(base.assignments, pass)) {
    assignments[key] = locationId
  }
  await state.set({ ...base, assignments, updatedAt: Date.now() })
}

/** Remember (or re-stamp) the volume id verified at one location's root. */
export async function rememberVolumeId(
  state: RecordingPlacementState,
  locationId: string,
  volumeId: string,
): Promise<void> {
  const blob = await state.get()
  await state.set({
    ...blob,
    volumeIds: { ...blob.volumeIds, [locationId]: volumeId },
    updatedAt: Date.now(),
  })
}

/** Operator pin: `locationId` null clears Auto. High/mid assignment keys follow. */
export async function writeDevicePin(
  state: RecordingPlacementState,
  deviceId: number,
  locationId: string | null,
): Promise<void> {
  const blob = await state.get()
  const pins = { ...blob.pins }
  const assignments = { ...blob.assignments }
  const key = String(deviceId)
  if (locationId === null) {
    delete pins[key]
  } else {
    pins[key] = locationId
    assignments[assignmentKey(deviceId, 'high')] = locationId
    assignments[assignmentKey(deviceId, 'mid')] = locationId
  }
  await state.set({ ...blob, pins, assignments, updatedAt: Date.now() })
}
