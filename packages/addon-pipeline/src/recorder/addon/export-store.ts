/**
 * Recording-export persistence for the recorder addon.
 *
 * ONE ROW PER EXPORT in the `recorder` / `exports` record kind, through a
 * {@link RecordKindHandle}. History rows are never removed by the system
 * (audit) — `deleteExport` / the janitor flip `state` and clear the file,
 * keeping the row.
 *
 * ## Records migration (phase 2, step 25)
 *
 * The store was previously backed by a {@link RowMapStore} over a SettingsStore
 * collection named `recorder:exports`. It is now backed by a
 * `RecordKindHandle<ExportRecord>` obtained from `ctx.records`. The record's
 * `at` field maps to `ExportRecord.createdAt`.
 *
 * The per-ID serialiser ({@link serialize}) is preserved: two overlapping
 * patches on the SAME export row are still read-modify-write, so they must
 * be ordered. The `RecordKindHandle` (an object) is used as the WeakMap key,
 * keeping the same compaction semantics.
 *
 * ## What the RowMapStore replaced, and why it mattered
 *
 * Every job used to live in one key of the recorder's `addon-settings` / `root`
 * blob — 201 833 bytes on the reference hub, of which the export history was
 * 50 441. The engine patches `progressPct` roughly once a second for an
 * in-flight render, so moving one integer read, parsed, re-serialised and
 * rewrote 201 KB, per second.
 *
 * Worse than the cost was the CLOBBER. Both halves of a read-modify-write are
 * async, so two overlapping cycles read the same snapshot and the second `set`
 * discarded whatever the first added. On 2026-08-14 a `createExport` for camera
 * 101 landed between one progress patch's read and its write, the row was
 * erased, and the poll answered `unknown export "547ea182-…"`; the scheduler
 * read the vanished row as a failed render and re-queued forever. A per-row
 * upsert makes that class of loss unrepresentable — a write names ONE row.
 */
import path from 'node:path'
import { ExportRecordSchema } from '@camstack/types'
import type { ExportRecord, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { recorderRecordKinds } from './record-kinds.js'

// Re-export for callers that need the legacy name for docs / adoption scripts.
export { RECORDING_EXPORTS_LEGACY_COLLECTION as RECORDING_EXPORTS_COLLECTION } from './record-kinds.js'

/**
 * The storage class export MP4s live in: `artifacts`, SHARED with the
 * notification-center's artifact shelf (operator 2026-09-04: one generic
 * class, not one per producer — D341), a declared SINGLETON. Never the addon
 * data dir: 8.4 GB of operator-exported clips sat in
 * `addons-data/recorder/exports`, inside every system backup, invisible to
 * occupancy and relocation, on the constrained appdata disk. And never a
 * `recordings`-class subtree: footage classes are quota-capped and swept, and
 * an export is something the operator DELIBERATELY created — its only
 * retention is its own (`expiresAt` chosen at creation + delete-after-
 * download), enforced by the export janitor and nothing else. Sharing the
 * LOCATION with the notification shelf never means sharing a SWEEP: each
 * tenant walks only its own subtree.
 *
 * Declared by BOTH consuming addons with identical cardinality — the
 * registry throws at kernel boot on a conflict, and each addon's pinning
 * spec holds its side of the agreement.
 */
export const ARTIFACTS_MEDIA_LOCATION = 'artifacts'

/**
 * `<root>/<deviceId>/exports/` — the exports TENANT subtree, DEVICE-FIRST
 * like the notification shelf's `<root>/<deviceId>/nc-artifacts/…` (operator
 * 2026-09-04: one directory per camera answers "what does this camera hold",
 * and per-device occupancy is uniform across both tenants). The ONE
 * derivation of the tenant dir — export MP4s, source playlists and the
 * ffconcat sidecar all live here; nothing may join the path a second way.
 */
export function exportTenantDirFor(root: string, deviceId: number): string {
  return path.join(root, String(deviceId), 'exports')
}

/**
 * `<root>/<deviceId>/exports/<exportId>.mp4` — the ONE derivation of an
 * export's file path, via {@link exportTenantDirFor}. Rows store no path, so
 * repointing the class root moves the whole library while every row keeps
 * resolving. A `null` root (location not yet resolved, or unresolvable)
 * REFUSES: falling back to the addon data dir is the failure mode this class
 * exists to end (D341).
 */
export function exportOutPathFor(root: string | null, deviceId: number, exportId: string): string {
  if (root === null) {
    throw new Error(
      'artifacts storage location is not resolved — exports refuse rather than fall back to the addon data dir',
    )
  }
  return path.join(exportTenantDirFor(root, deviceId), `${exportId}.mp4`)
}

/**
 * Bound for the whole-history read. Explicit because a records query without
 * an explicit limit uses the default cap (100); an export list that silently
 * loses its oldest entries looks exactly like a purge.
 */
export const RECORDING_EXPORTS_LIMIT = 20_000

/** Row-per-export handle over the `recorder` / `exports` record kind. */
export type RecordingExportsState = RecordKindHandle<ExportRecord>

/**
 * Obtain the `recorder` / `exports` record kind handle.
 * `ctx.records.declare(recorderRecordKinds)` MUST have run before any read or
 * write (called at boot in `onInitialize`).
 */
export function recordingExportsState(records: RecordsAccess): RecordingExportsState {
  return records.kind(recorderRecordKinds['exports'])
}

/**
 * One in-flight mutation chain per (handle, export id).
 *
 * Two overlapping patches on the SAME export still read-modify-write one row.
 * Serialising per id keeps them atomic while leaving unrelated exports fully
 * concurrent. A `WeakMap` keyed by the handle keeps a disposed handle
 * collectable; the inner map is keyed by export id.
 */
const mutationChains = new WeakMap<RecordingExportsState, Map<string, Promise<unknown>>>()

/** Run `work` after every mutation already queued for `(state, id)`, never before. */
async function serialize<T>(
  state: RecordingExportsState,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = mutationChains.get(state)
  const queued = existing ?? new Map<string, Promise<unknown>>()
  if (existing === undefined) mutationChains.set(state, queued)
  const previous = queued.get(id) ?? Promise.resolve()
  // `.then(work, work)` and not `.finally(work)`: a mutation that REJECTED must
  // not poison every later one, and the chain must advance either way.
  const next = previous.then(work, work)
  const settled = next.catch(() => undefined)
  queued.set(id, settled)
  // Garbage-collect a settled chain so the map does not grow one entry per
  // export for the lifetime of the addon.
  void settled.then(() => {
    if (queued.get(id) === settled) queued.delete(id)
  })
  return next
}

/** Read every persisted export row, keyed by export id. */
export async function readExports(
  state: RecordingExportsState,
): Promise<Map<string, ExportRecord>> {
  const result = await state.query({ limit: RECORDING_EXPORTS_LIMIT })
  const out = new Map<string, ExportRecord>()
  for (const row of result.records) out.set(row.id, row.data)
  return out
}

/** Insert or replace one export row. Validates at the boundary. Returns it. */
export async function upsertExport(
  state: RecordingExportsState,
  record: ExportRecord,
): Promise<ExportRecord> {
  const validated = ExportRecordSchema.parse(record)
  return serialize(state, validated.id, async () => {
    await state.put({ id: validated.id, at: validated.createdAt, data: validated })
    return validated
  })
}

/**
 * Shallow-merge a patch into one export row and persist. Returns the merged
 * record, or null when the id is unknown.
 */
export async function patchExport(
  state: RecordingExportsState,
  id: string,
  patch: Partial<ExportRecord>,
): Promise<ExportRecord | null> {
  return serialize(state, id, async () => {
    const row = await state.get(id)
    if (row === null) return null
    const merged = ExportRecordSchema.parse({ ...row.data, ...patch })
    await state.put({ id, at: merged.createdAt, data: merged })
    return merged
  })
}

/** What {@link patchExportUnless} did. */
export type ConditionalPatchResult =
  | { readonly kind: 'patched'; readonly record: ExportRecord }
  | { readonly kind: 'refused'; readonly record: ExportRecord }
  | { readonly kind: 'missing' }

/**
 * Patch a row UNLESS its current state says not to — the check and the write
 * are ONE serialized step, so a delete that lands between a separate read and
 * a separate patch can no longer be overwritten (review R5).
 */
export async function patchExportUnless(
  state: RecordingExportsState,
  id: string,
  patch: Partial<ExportRecord>,
  refuse: (current: ExportRecord) => boolean,
): Promise<ConditionalPatchResult> {
  return serialize(state, id, async (): Promise<ConditionalPatchResult> => {
    const row = await state.get(id)
    if (row === null) return { kind: 'missing' }
    if (refuse(row.data)) return { kind: 'refused', record: row.data }
    const merged = ExportRecordSchema.parse({ ...row.data, ...patch })
    await state.put({ id, at: merged.createdAt, data: merged })
    return { kind: 'patched', record: merged }
  })
}

/** Remove an export row entirely (rarely used — deletion keeps the row). */
export async function removeExport(state: RecordingExportsState, id: string): Promise<void> {
  return serialize(state, id, async () => {
    await state.delete(id)
  })
}

/** Read one export row by id — ONE keyed row read. */
export async function getExportRecord(
  state: RecordingExportsState,
  id: string,
): Promise<ExportRecord | null> {
  const row = await state.get(id)
  return row === null ? null : row.data
}

/**
 * List export rows, newest-first (by `createdAt` / record `at`), optionally
 * scoped to one device.
 *
 * Scoped to a device this is an INDEXED query on the `device` index — not a
 * parse of every export in the installation followed by a filter in JS.
 */
export async function listExportsFor(
  state: RecordingExportsState,
  deviceId?: number,
): Promise<ExportRecord[]> {
  const result = await state.query({
    ...(deviceId === undefined ? {} : { where: { deviceId } }),
    desc: true,
    limit: RECORDING_EXPORTS_LIMIT,
  })
  return result.records.map((r) => r.data)
}
