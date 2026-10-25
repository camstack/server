/**
 * May THIS node keep the notification-artefact shelf?
 *
 * ## What this stops
 *
 * The shelf is a directory: `start()` does `mkdir -p` on the path
 * `storage.resolve` hands back for the `artifacts` location. That location is
 * configured once, cluster-wide, and it names the node whose disk it is — on
 * this hub `artifacts:default` is `/media-fast/artifacts` on `hub`.
 *
 * Every node runs this addon, so every node resolved that path and tried to
 * create it. On the Mac agent `/media-fast` does not exist (`ENOENT`); on
 * `agent-a` it exists and is not ours (`EACCES`). Both logged
 * `nc-artifact data-plane failed to serve` on a loop, and the EACCES one is the
 * worse of the two: a path of the same name on another machine is not the same
 * directory, and `mkdir -p` of somebody else's mount point is precisely the
 * mistake D296 refuses for remote providers. This is its sibling — the provider
 * IS node-local, just not to THIS node.
 *
 * ## The id the kernel answers is not the id the location carries
 *
 * `ctx.kernel.localNodeId` is `"hub/pipeline-analytics"` — node AND runner —
 * while a location's `nodeId` is the bare `"hub"`. Compared raw, the HUB
 * refuses its own shelf: no bytes are written anywhere, and the summary
 * notifications lose their mosaics. That shipped, for forty minutes, on
 * 2026-09-13. The normalisation (`split('/')[0]`) already existed ten lines
 * above the call site, applied to the same value for the ops log; I wrote a new
 * comparison instead of looking for the one the file already used.
 *
 * ## Why a positive mismatch only
 *
 * A location with no `nodeId` is not somebody else's; it is unclassified, and a
 * refusal drawn from a read that was never made is how a doorbell rang 0/3
 * (D49). Likewise a node that cannot name itself refuses nothing — that would
 * disable the shelf on the hub, the one node where it must run.
 */

/** The `artifacts` location id, as the recorder declares it. */
const ARTIFACT_LOCATION_ID = 'artifacts'

/** What this decision needs from a `storage.listLocations` row. */
export interface ArtifactLocationRow {
  readonly id: string
  /** The node whose disk this is. Absent on an unclassified row. */
  readonly nodeId?: string | undefined
}

/**
 * A sentence explaining why this node must not keep the shelf, or `null` when
 * it may. The sentence is the log line: an operator reading it should learn
 * WHICH node owns the shelf without opening the storage page.
 */
export function artifactShelfRefusal(
  locations: readonly ArtifactLocationRow[],
  localNodeId: string | null,
): string | null {
  if (localNodeId === null || localNodeId.length === 0) return null
  // `<node>/<runner>` → `<node>`. See the header.
  const here = localNodeId.includes('/') ? (localNodeId.split('/')[0] ?? '') : localNodeId
  if (here.length === 0) return null
  for (const location of locations) {
    if (!location.id.startsWith(ARTIFACT_LOCATION_ID)) continue
    const owner = location.nodeId
    if (owner === undefined || owner.length === 0 || owner === here) continue
    return (
      `the artefact shelf lives on node "${owner}" (location "${location.id}"), not on ` +
      `"${here}" — the path it resolves to is that node's disk, and creating it here ` +
      `would make a directory of the same name that nothing reads. Artefacts are produced, ` +
      `stored and served by "${owner}".`
    )
  }
  return null
}
