/**
 * Moving a location's bytes when its root is re-pointed.
 *
 * ## Why this exists, and why only for singletons
 *
 * A `multi` location moves the sanctioned way: register a second instance,
 * drain the first, watch it empty (D386). A **singleton** cannot — the
 * cardinality guard in `upsertLocation` refuses the second instance by
 * declaration, so there is no destination to drain into. For those, editing
 * the `basePath` IS the migration, and either it carries the data or the data
 * is stranded.
 *
 * It was stranded. On 2026-09-08 the `artifacts` root moved and 320 enrolled
 * gallery blobs stayed at the previous path — invisible until every face in the
 * Review panel answered 404, and one boot away from being collected as "the
 * pixels are gone" by a reconcile that had no way to know better.
 *
 * ## The order is the safety property
 *
 * copy → verify → (caller saves the row) → delete. A crash at any point leaves
 * the bytes somewhere that a location still points at: before the row moves,
 * that is the OLD root; after it, the new one holds a verified copy. Nothing
 * here deletes anything until every file has landed and been read back.
 *
 * A failure ABORTS with nothing deleted, so the caller can refuse the edit and
 * leave the operator pointing at intact data.
 *
 * I/O is injected: the walk and the ordering are what matter and they are
 * testable without a filesystem.
 */

import type { PathVerdict } from './location-class-paths.js'

/** The four operations a move needs, in the caller's own terms. */
export interface RepointMoveIo {
  /** Entries directly under `prefix` (undefined = the root), as relative paths. */
  list(prefix: string | undefined): Promise<readonly string[]>
  /** Bytes of a source file. THROWS when the path is a directory. */
  read(relativePath: string): Promise<Uint8Array<ArrayBuffer>>
  /** Write into the destination root. */
  write(relativePath: string, data: Uint8Array<ArrayBuffer>): Promise<void>
  /** Read back from the DESTINATION, to prove the copy landed. */
  readBack(relativePath: string): Promise<Uint8Array<ArrayBuffer>>
  /** Remove one file from the source root. */
  deleteSource(relativePath: string): Promise<void>
}

export interface RepointMoveResult {
  readonly files: number
  readonly bytes: number
}

/**
 * Walk the source root and collect FILES.
 *
 * The storage cap's `list` reports names without saying which are directories,
 * so the walk decides by asking: an entry that lists children is a directory,
 * and one that lists none is a leaf. A leaf that turns out not to be readable
 * (an empty directory) is skipped by the copy loop, which is the only place
 * that can tell — and skipping it is right, since there is nothing to move.
 */
async function collectFiles(
  io: RepointMoveIo,
  scope: RepointScope,
  prefix?: string,
): Promise<readonly string[]> {
  const entries = await io.list(prefix)
  const files: string[] = []
  for (const entry of entries) {
    const verdict = scope(entry)
    // Another class's data on a shared root: not ours to read, copy or delete.
    if (verdict === 'foreign') continue
    const children = await io.list(entry)
    if (children.length > 0) {
      files.push(...(await collectFiles(io, scope, entry)))
      continue
    }
    // An ancestor of the subtree with no children is an empty camera directory
    // or a stray root file — neither is this class's to move.
    if (verdict === 'own') files.push(entry)
  }
  return files
}

/** Decides, per root-relative path, whether it belongs to the moving location. */
export type RepointScope = (relativePath: string) => PathVerdict

/** The whole root — only correct for a class that owns all of it. */
export const WHOLE_ROOT: RepointScope = () => 'own'

/**
 * Copy every file from the source root to the destination, verify each, then
 * delete the originals. Throws with NOTHING deleted if any copy fails.
 */
export async function moveLocationTree(
  io: RepointMoveIo,
  scope: RepointScope = WHOLE_ROOT,
): Promise<RepointMoveResult> {
  const candidates = await collectFiles(io, scope)
  const copied: string[] = []
  let bytes = 0

  for (const relativePath of candidates) {
    let data: Uint8Array<ArrayBuffer>
    try {
      data = await io.read(relativePath)
    } catch {
      // An empty directory, or a leaf that vanished between the walk and the
      // copy. Neither is a file to move and neither is a failure.
      continue
    }
    await io.write(relativePath, data)
    const landed = await io.readBack(relativePath)
    if (landed.length !== data.length) {
      throw new Error(
        `location repoint: size mismatch after copying "${relativePath}" ` +
          `(${String(landed.length)} != ${String(data.length)}) — nothing deleted`,
      )
    }
    copied.push(relativePath)
    bytes += data.length
  }

  // Only now, with every byte verified at the destination.
  for (const relativePath of copied) await io.deleteSource(relativePath)
  return { files: copied.length, bytes }
}
