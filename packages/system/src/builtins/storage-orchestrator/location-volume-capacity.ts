/**
 * `StorageLocation.capacity` — the ONE place a location's volume is measured,
 * and the one place that decides a volume cannot be measured from here.
 *
 * ## What it is measuring
 *
 * `statfs` answers "how big is the volume, and how much of it is free". It is a
 * fact about a MOUNT on THIS node. A location only has such a fact when three
 * things hold at once: the provider serves a genuine local filesystem
 * (`getProviderInfo().nodeLocal`), the location belongs to this node, and its
 * `basePath` names an absolute path on it. Miss any of them and the correct
 * answer is `unknown` — which the cap carries as a null `capacity` and the
 * admin UI renders as "Capacity unknown", with no bar (D315: an empty bar reads
 * as plenty of room).
 *
 * ## The defect that made this a module
 *
 * Measured on the live hub, 2026-09-13. `storage.listLocations` returned two
 * `backups` locations with byte-identical capacity — `/data/backups` on
 * `filesystem-storage` and `//192.168.10.89/backups` on `smb-storage`, both
 * `total 506107977728 / available 193348673536`. `owned` differed correctly
 * (9.9 GB vs 1.6 GB), so nothing about the rendering was at fault: the probe
 * simply never looked at the provider. It `path.resolve`d the SMB row's
 * share-relative `basePath: "camstack"` against the hub process's cwd, found no
 * such directory, walked up to the nearest existing ancestor — the container
 * root — and reported the HUB's own disk as the share's. The operator was told
 * an SMB share was 62% full by a reading nobody had taken of it.
 *
 * This is D296's shape in a third place. `access-guards.ts` already refuses
 * `resolve` and occupancy probes on a remote-backed location for the same
 * reason; a `statfs` is the same mistake with a number attached instead of a
 * path. It is also D393: a measurement that failed is `null`, never a figure —
 * and the reason travels with it so the caller can log which fault it is.
 *
 * ## The ancestor walk, and where it stops
 *
 * A node-local root that has not been created yet is normal (first boot, a new
 * location). Measuring the nearest EXISTING ancestor is honest there: it is the
 * volume a write would land on today. It stops being honest at the filesystem
 * root — reaching `/` means every named segment is missing, which is what an
 * unmounted array looks like, and reporting the root disk's size as the array's
 * is the same lie in a smaller font. That case is `unknown`.
 */
import path from 'node:path'
import type { StorageLocation } from '@camstack/types'
import type { ProviderLocality } from './access-guards.js'

/** The three `statfs` fields capacity is derived from (`node:fs` StatsFs). */
export interface StatfsFacts {
  readonly blocks: number
  readonly bsize: number
  readonly bavail: number
}

/** The filesystem reads the probe takes, injected so the decision is testable. */
export interface VolumeProbe {
  readonly access: (target: string) => Promise<void>
  readonly statfs: (target: string) => Promise<StatfsFacts>
}

export interface VolumeProbeDeps {
  readonly probe: VolumeProbe
  /** Only ever used to REJECT a relative `basePath` by naming what it would
   *  have resolved against — never to resolve one. */
  readonly cwd: string
}

/**
 * A measurement, or the reason there is none. `unknown` is never folded into a
 * number: `0` free means "full" to every reader of this figure (D393).
 */
export type LocalVolumeCapacity =
  | {
      readonly kind: 'measured'
      /** The path actually stat'd — the location's root, or an ancestor of it. */
      readonly path: string
      readonly totalBytes: number
      readonly availableBytes: number
    }
  | { readonly kind: 'unknown'; readonly reason: string }

function unknown(reason: string): LocalVolumeCapacity {
  return { kind: 'unknown', reason }
}

/** The two figures the cap carries, or `null` — never a zero standing in. */
export interface MeasuredVolume {
  readonly totalBytes: number
  readonly availableBytes: number
}

/**
 * Free percent for the pressure guard. An unmeasurable volume answers `100`,
 * which is the value that keeps the guard INERT: a disk nobody measured must
 * never be the reason footage is deleted (D393).
 */
export function freePercentOf(capacity: MeasuredVolume | null): number {
  if (capacity === null || capacity.totalBytes <= 0) return 100
  return (capacity.availableBytes / capacity.totalBytes) * 100
}

/**
 * Volume total for turning a deficit percentage into a byte target. `0` on an
 * unmeasurable volume — the guard's own stop condition reads that as "no
 * target", so nothing is evicted on a reading nobody took.
 */
export function volumeTotalBytesOf(capacity: MeasuredVolume | null): number {
  return capacity === null ? 0 : capacity.totalBytes
}

/**
 * May this node take a `statfs` that is genuinely ABOUT this location?
 *
 * Unlike `resolveRefusalFor`, an unclassified provider (`undefined`) answers
 * no. That guard protects a WRITE, where refusing on a read nobody made would
 * break a working location (D49); here the product is a number an operator
 * reads, and a number justified by an unmade read is exactly what this module
 * exists to stop.
 */
function probePathFor(
  location: StorageLocation,
  locality: ProviderLocality,
  localNodeId: string,
  cwd: string,
): { readonly path: string } | { readonly reason: string } {
  if (locality !== true) {
    const why =
      locality === false
        ? `is served by the remote provider "${location.providerId}" (nodeLocal: false) — ` +
          `its bytes live on the remote host and no local statfs describes them`
        : `is served by "${location.providerId}", which this node has not classified yet ` +
          `(no getProviderInfo answer) — a local statfs would be a guess`
    return { reason: `location "${location.id}" ${why}` }
  }
  if (location.nodeId !== undefined && location.nodeId !== localNodeId) {
    return {
      reason:
        `location "${location.id}" lives on node "${location.nodeId}" and this is ` +
        `"${localNodeId}" — only the owning node can statfs its own volumes`,
    }
  }
  const basePath = location.config['basePath']
  if (typeof basePath !== 'string' || basePath.length === 0) {
    return { reason: `location "${location.id}" declares no basePath to measure` }
  }
  if (!path.isAbsolute(basePath)) {
    return {
      reason:
        `location "${location.id}" declares a RELATIVE basePath ("${basePath}") — that is a ` +
        `path inside its provider's own namespace, not on this node's filesystem, and ` +
        `resolving it against "${cwd}" would measure an unrelated volume`,
    }
  }
  return { path: path.resolve(basePath) }
}

/**
 * Free + total bytes on the volume backing `location`, or why there are none.
 *
 * Never throws: an unreachable volume is one degraded ROW, not a failed
 * `listLocations` — a NAS that stops answering must not blank the capacity of
 * every other disk on the node.
 */
export async function readLocalVolumeCapacity(
  location: StorageLocation,
  locality: ProviderLocality,
  localNodeId: string,
  deps: VolumeProbeDeps,
): Promise<LocalVolumeCapacity> {
  const target = probePathFor(location, locality, localNodeId, deps.cwd)
  if ('reason' in target) return unknown(target.reason)

  const root = path.parse(target.path).root
  let probed = target.path
  for (;;) {
    try {
      await deps.probe.access(probed)
      break
    } catch {
      const parent = path.dirname(probed)
      if (parent === probed) {
        return unknown(
          `nothing on the path "${target.path}" exists on this node — the volume is ` +
            `not mounted, so the root filesystem's size is not an answer about it`,
        )
      }
      probed = parent
    }
  }
  // Only the location's OWN root may be the filesystem root; an ancestor walk
  // that lands there has climbed off the volume it was asked about.
  if (probed === root && target.path !== root) {
    return unknown(
      `only the filesystem root exists on the path "${target.path}" — the volume is ` +
        `not mounted, so the root filesystem's size is not an answer about it`,
    )
  }

  try {
    const st = await deps.probe.statfs(probed)
    return {
      kind: 'measured',
      path: probed,
      totalBytes: st.blocks * st.bsize,
      availableBytes: st.bavail * st.bsize,
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    return unknown(`statfs("${probed}") failed: ${reason}`)
  }
}
