/**
 * Class-subtree wipe — the filesystem half of discarding a frozen location
 * that SHARES its root with another class (today: Toshiba `/recordings`
 * holds events + low + high).
 *
 * The only directories this module will `rm` are
 * `<root>/<camera>/<subtree>` for `subtree` in the class map. It refuses
 * a path that is not exactly two levels under the root, a symlink, or a
 * subtree the class did not name. `rm` of the location root is not a
 * code path.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DISCARD_SUBTREES: Readonly<Record<string, readonly string[]>> = {
  eventMedia: ['events'],
  recordingsLow: ['low'],
  recordings: ['high', 'mid'],
}

export function discardSubtreesForType(type: string): readonly string[] | null {
  return DISCARD_SUBTREES[type] ?? null
}

export interface ClassWipeProgress {
  readonly camerasTotal: number
  readonly camerasDone: number
  readonly cameraId: string
  readonly foldersRemoved: number
}

export interface ClassWipeResult {
  readonly camerasDone: number
  readonly foldersRemoved: number
  readonly cancelled: boolean
}

export interface ClassWipeFs {
  readonly readdir: (dir: string) => Promise<readonly { name: string; isDirectory(): boolean }[]>
  readonly lstat: (target: string) => Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>
  readonly rm: (target: string) => Promise<void>
}

const DEFAULT_FS: ClassWipeFs = {
  readdir: (dir) => fs.readdir(dir, { withFileTypes: true }),
  lstat: (target) => fs.lstat(target),
  rm: (target) => fs.rm(target, { recursive: true, force: true }),
}

/**
 * Resolve `<root>/<camera>/<subtree>` and refuse anything that is not
 * exactly that shape under `root`. The check is lexical (after
 * `path.resolve`) so `../high` in a camera name cannot escape.
 */
export function resolveClassDir(root: string, cameraId: string, subtree: string): string {
  if (cameraId.length === 0 || cameraId === '.' || cameraId === '..') {
    throw new Error(`discard: illegal camera id ${cameraId}`)
  }
  if (subtree.includes('/') || subtree.includes('\\') || subtree === '..' || subtree === '.') {
    throw new Error(`discard: illegal subtree ${subtree}`)
  }
  const rootResolved = path.resolve(root)
  const target = path.resolve(rootResolved, cameraId, subtree)
  const rel = path.relative(rootResolved, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`discard: path escaped root: ${target}`)
  }
  const parts = rel.split(path.sep).filter((p) => p.length > 0)
  if (parts.length !== 2 || parts[0] !== cameraId || parts[1] !== subtree) {
    throw new Error(`discard: path is not a class subtree: ${target}`)
  }
  return target
}

export async function wipeClassSubtrees(input: {
  readonly root: string
  readonly type: string
  readonly stop: () => boolean
  readonly onProgress: (p: ClassWipeProgress) => void
  readonly pace?: () => Promise<void>
  readonly io?: ClassWipeFs
}): Promise<ClassWipeResult> {
  const subtrees = discardSubtreesForType(input.type)
  if (subtrees === null) throw new Error(`discard: unknown location type ${input.type}`)
  const io = input.io ?? DEFAULT_FS
  const rootResolved = path.resolve(input.root)
  let cameras: readonly { name: string; isDirectory(): boolean }[]
  try {
    cameras = await io.readdir(rootResolved)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      return { camerasDone: 0, foldersRemoved: 0, cancelled: false }
    }
    throw err
  }
  const dirs = cameras.filter((e) => e.isDirectory() && e.name !== '.' && e.name !== '..')
  let camerasDone = 0
  let foldersRemoved = 0
  for (const dir of dirs) {
    if (input.stop()) {
      return { camerasDone, foldersRemoved, cancelled: true }
    }
    for (const subtree of subtrees) {
      const target = resolveClassDir(rootResolved, dir.name, subtree)
      let st: { isSymbolicLink(): boolean; isDirectory(): boolean }
      try {
        st = await io.lstat(target)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'ENOENT') continue
        throw err
      }
      if (st.isSymbolicLink()) {
        throw new Error(`discard: refusing to wipe symlink ${target}`)
      }
      if (!st.isDirectory()) continue
      await io.rm(target)
      foldersRemoved += 1
    }
    camerasDone += 1
    input.onProgress({
      camerasTotal: dirs.length,
      camerasDone,
      cameraId: dir.name,
      foldersRemoved,
    })
    if (input.pace) await input.pace()
  }
  return { camerasDone, foldersRemoved, cancelled: false }
}
