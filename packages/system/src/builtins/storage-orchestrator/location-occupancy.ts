/**
 * Delete-time occupancy of a location's on-disk root.
 *
 * A recordings disk may host several classes at one `basePath`
 * (`<camera>/high|mid`, `<camera>/low`, `<camera>/events`). Occupancy for
 * a class is therefore the class subtree, not the shared root — otherwise a
 * drained `eventMedia:default` still looks full because high footage is
 * writing next to it (observed 2026-09-01).
 *
 * A subtree is occupied iff a FILE exists anywhere beneath it: a drain
 * leaves empty date folders behind, and those must not block a delete. The
 * walk is depth-first and stops at the first file, so an occupied disk is
 * answered fast; only a drained tree is walked in full (directories only).
 */
import { opendir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { LocationOccupancy } from './storage-orchestrator.service.js'

/**
 * Class → directories under `<root>/<camera>/`. Same map as the discard
 * wipe (`DISCARD_SUBTREES` in the recorder / pipeline-analytics addons).
 * Types not listed keep the legacy "any non-dot entry at the root" rule
 * (backups, addon-data, …).
 */
export const STORAGE_CLASS_SUBTREES: Readonly<Record<string, readonly string[]>> = {
  eventMedia: ['events'],
  recordingsLow: ['low'],
  recordings: ['high', 'mid'],
}

function isDotEntry(name: string): boolean {
  return name.startsWith('.')
}

/**
 * True when `dir` exists and holds at least one non-directory entry (a file,
 * symlink, …) anywhere beneath it. Empty folders (the date directories a
 * drain leaves behind) do not count. Depth-first, stops at the first file.
 * Missing → false. Any other errno throws so the caller can answer
 * `unknown` (D49).
 */
async function dirHasAnyFile(dir: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof opendir>>
  try {
    handle = await opendir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  const subdirs: string[] = []
  try {
    for await (const entry of handle) {
      if (!entry.isDirectory()) return true
      subdirs.push(path.join(dir, entry.name))
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  for (const sub of subdirs) {
    if (await dirHasAnyFile(sub)) return true
  }
  return false
}

/**
 * Occupancy of `basePath` for a location of `type`.
 *
 *  - missing root → `empty` (nothing this delete can strand)
 *  - class-mapped type → occupied iff any `<camera>/<subtree>` holds a file (empty folders do not count)
 *  - other types → occupied iff the root has a non-dot entry
 */
export async function probeLocalDirectoryOccupancy(input: {
  readonly type: string
  readonly basePath: string
}): Promise<LocationOccupancy> {
  let names: string[]
  try {
    names = await readdir(input.basePath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'empty'
    return 'unknown'
  }

  const visible = names.filter((name) => !isDotEntry(name))
  const subtrees = STORAGE_CLASS_SUBTREES[input.type]
  if (subtrees === undefined) {
    return visible.length > 0 ? 'occupied' : 'empty'
  }

  try {
    for (const camera of visible) {
      for (const subtree of subtrees) {
        if (await dirHasAnyFile(path.join(input.basePath, camera, subtree))) {
          return 'occupied'
        }
      }
    }
  } catch {
    return 'unknown'
  }
  return 'empty'
}
