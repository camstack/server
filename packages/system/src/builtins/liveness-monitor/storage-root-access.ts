/**
 * Can this node WRITE where its storage locations say media goes?
 *
 * 2026-10-23, a fresh install of the dev hub: the bind mounted at
 * `/recordings` was `root:root 0755` while the hub runs as uid 1001. Nothing
 * said so at boot; the first sign was an `EACCES` on `/recordings/artifacts`,
 * and recordings would have failed one write at a time. A root the process
 * cannot write is a fact known the moment the node starts, so it is reported
 * then — once, naming the path, its owner, its mode and the uid — instead of
 * as a stream of per-write errors.
 *
 * Only a location this node may WRITE (`mayWriteToLocation`), served by the
 * local filesystem provider, on this node, with an absolute `basePath`, is
 * judged. A root that does not exist yet is judged by its nearest existing
 * ancestor: that is the directory the node would have to create it in.
 *
 * A probe that cannot answer (a stat that fails for a reason other than
 * permission) is `unknown` and never a finding (D393): an unreadable fact is
 * not an unwritable disk.
 */
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { errMsg, mayWriteToLocation, type StorageLocation } from '@camstack/types'
import type { LivenessFinding } from './liveness-checks.js'

/** The local filesystem storage provider's id (`FilesystemStorageProvider.providerId`). */
const FILESYSTEM_PROVIDER_ID = 'filesystem-storage'

const UNWRITABLE_PREFIX = 'liveness:storage-root-unwritable:'

/** Owner and permission bits of a directory, as `stat` reports them. */
export interface DirStat {
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

/** The two filesystem reads the check makes; injected so a test can run without root. */
export interface StorageRootProbe {
  /** Resolves when the CURRENT process may write (and traverse) `dir`; rejects otherwise. */
  readonly canWrite: (dir: string) => Promise<void>
  readonly stat: (dir: string) => Promise<DirStat>
  /** The process uid/gid, or `null` where the platform has none (Windows). */
  readonly processUid: number | null
  readonly processGid: number | null
}

/** One root this node must be able to write, and every location that writes under it. */
export interface StorageRootTarget {
  readonly path: string
  readonly locationIds: readonly string[]
}

export type StorageRootAccess =
  | { readonly kind: 'writable'; readonly target: StorageRootTarget }
  | {
      readonly kind: 'unwritable'
      readonly target: StorageRootTarget
      /** The directory that refused: the root itself, or its nearest existing ancestor. */
      readonly blockedAt: string
      readonly stat: DirStat
      readonly reason: string
    }
  | { readonly kind: 'unknown'; readonly target: StorageRootTarget; readonly reason: string }

/** The hub-local, writable filesystem roots among `locations`, deduplicated by path. */
export function storageRootTargets(
  locations: readonly StorageLocation[],
  localNodeId: string,
): readonly StorageRootTarget[] {
  const byPath = new Map<string, string[]>()
  for (const location of locations) {
    if (location.providerId !== FILESYSTEM_PROVIDER_ID) continue
    if (location.nodeId !== undefined && location.nodeId !== localNodeId) continue
    if (!mayWriteToLocation(location)) continue
    const basePath = location.config['basePath']
    if (typeof basePath !== 'string' || !path.isAbsolute(basePath)) continue
    const root = path.resolve(basePath)
    byPath.set(root, [...(byPath.get(root) ?? []), location.id])
  }
  return [...byPath.entries()]
    .map(([root, locationIds]) => ({ path: root, locationIds: locationIds.toSorted() }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')
}

/** Probe one root: the root itself, or the nearest ancestor that exists. */
export async function probeStorageRoot(
  target: StorageRootTarget,
  probe: StorageRootProbe,
): Promise<StorageRootAccess> {
  let dir = target.path
  let stat: DirStat
  for (;;) {
    try {
      stat = await probe.stat(dir)
      break
    } catch (err: unknown) {
      const parent = path.dirname(dir)
      if (!isMissing(err) || parent === dir) {
        return { kind: 'unknown', target, reason: `stat ${dir} failed: ${errMsg(err)}` }
      }
      dir = parent
    }
  }
  try {
    await probe.canWrite(dir)
    return { kind: 'writable', target }
  } catch (err: unknown) {
    return { kind: 'unwritable', target, blockedAt: dir, stat, reason: errMsg(err) }
  }
}

function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

function processIdentity(probe: StorageRootProbe): string {
  if (probe.processUid === null) return 'this process'
  return (
    `uid ${String(probe.processUid)}` +
    (probe.processGid === null ? '' : ` (gid ${String(probe.processGid)})`)
  )
}

/**
 * One finding per DIRECTORY that refused — several roots under one unwritable
 * mount (`/recordings` holding recordings, event media and artifacts) are one
 * cause and one alert. Stable id = that directory.
 */
export function storageRootFindings(
  results: readonly StorageRootAccess[],
  probe: StorageRootProbe,
): readonly LivenessFinding[] {
  const byBlocked = new Map<string, { stat: DirStat; roots: string[]; locationIds: string[] }>()
  for (const result of results) {
    if (result.kind !== 'unwritable') continue
    const entry = byBlocked.get(result.blockedAt) ?? {
      stat: result.stat,
      roots: [],
      locationIds: [],
    }
    entry.roots.push(result.target.path)
    entry.locationIds.push(...result.target.locationIds)
    byBlocked.set(result.blockedAt, entry)
  }
  const uidFix = probe.processUid === null ? '<uid>' : String(probe.processUid)
  const gidFix = probe.processGid === null ? '<gid>' : String(probe.processGid)
  return [...byBlocked.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([blockedAt, { stat, roots, locationIds }]): LivenessFinding => {
      const missing = roots.filter((r) => r !== blockedAt)
      const below = missing.length > 0 ? ` (${missing.join(', ')} must be created inside it)` : ''
      return {
        id: `${UNWRITABLE_PREFIX}${blockedAt}`,
        severity: 'error',
        title: 'Storage location not writable',
        message:
          `${blockedAt} is owned by ${String(stat.uid)}:${String(stat.gid)} with mode ` +
          `${octalMode(stat.mode)}, and CamStack runs as ${processIdentity(probe)} — ` +
          `nothing can be written there${below}. Locations affected: ` +
          `${locationIds.toSorted().join(', ')}. Fix the ownership on the host, e.g. ` +
          `chown -R ${uidFix}:${gidFix} <the host directory bound at ${blockedAt}>.`,
      }
    })
}

export function isStorageRootFindingId(id: string): boolean {
  return id.startsWith(UNWRITABLE_PREFIX)
}

/** The real probe: `fs.access(W_OK | X_OK)` as THIS process, and `fs.stat`. */
export function nodeStorageRootProbe(fs: {
  readonly access: (p: string, mode: number) => Promise<void>
  readonly stat: (p: string) => Promise<DirStat>
}): StorageRootProbe {
  return {
    canWrite: (dir) => fs.access(dir, fsConstants.W_OK | fsConstants.X_OK),
    stat: async (dir) => {
      const st = await fs.stat(dir)
      return { uid: st.uid, gid: st.gid, mode: st.mode }
    },
    processUid: typeof process.getuid === 'function' ? process.getuid() : null,
    processGid: typeof process.getgid === 'function' ? process.getgid() : null,
  }
}
