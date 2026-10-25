import { describe, expect, it } from 'vitest'
import { type ArtifactLocationRow, artifactShelfRefusal } from './artifact-locality.js'

const HERE = 'agent-a'

function loc(over: Partial<ArtifactLocationRow> = {}): ArtifactLocationRow {
  return { id: 'artifacts:default', nodeId: 'hub', ...over }
}

describe('artifactShelfRefusal', () => {
  it('refuses a location that belongs to ANOTHER node', () => {
    // `/media-fast/artifacts` is the hub's disk. On this node the path is
    // either missing (ENOENT, the Mac) or an unrelated directory we may not
    // write (EACCES, agent-a) — and `mkdir -p` of somebody else's mount
    // point is the one thing this must never do.
    const why = artifactShelfRefusal([loc()], HERE)
    expect(why).not.toBeNull()
    expect(why).toContain('hub')
  })

  it('allows the location that belongs to THIS node', () => {
    expect(artifactShelfRefusal([loc({ nodeId: HERE })], HERE)).toBeNull()
  })

  it('allows a location that names no node — it is not somebody else’s', () => {
    // A row written before locations carried a node, or a provider that does
    // not place its storage on one. Unknown is not "another node's" (D49): the
    // refusal only ever fires on a POSITIVE mismatch.
    expect(artifactShelfRefusal([loc({ nodeId: undefined })], HERE)).toBeNull()
  })

  it('allows when the artefact location is not configured at all', () => {
    // Nothing to contradict. The shelf then fails or succeeds on its own terms,
    // exactly as before this guard existed.
    expect(artifactShelfRefusal([], HERE)).toBeNull()
    expect(artifactShelfRefusal([loc({ id: 'eventMedia:ssd' })], HERE)).toBeNull()
  })

  it('takes the NODE out of a runner id — the shape the kernel actually answers', () => {
    // `ctx.kernel.localNodeId` answers `"hub/pipeline-analytics"`, not `"hub"`.
    // Compared raw, the HUB refused its own shelf: no mosaic bytes anywhere, and
    // the summary notifications lost their pictures. Ten lines above the call
    // site the same file already did `rawNodeId.split('/')[0]` — the
    // normalisation existed and I did not look for it.
    expect(artifactShelfRefusal([loc({ nodeId: 'hub' })], 'hub/pipeline-analytics')).toBeNull()
    expect(
      artifactShelfRefusal([loc({ nodeId: 'hub' })], 'agent-a/pipeline-analytics'),
    ).not.toBeNull()
  })

  it('allows when this node does not know its own id', () => {
    // Refusing on an unknown SELF would disable the shelf on the hub too, which
    // is where it is the only place it can run.
    expect(artifactShelfRefusal([loc()], null)).toBeNull()
  })
})

/**
 * The regression this file's caller shipped for forty minutes on 2026-09-13.
 *
 * The guard was correct and it was applied one step too early: it returned
 * before the artefact INDEX was built, so the agents stopped serving a read
 * surface that touches no filesystem at all. The viewer's Media tab, whose
 * `nc.listArtifacts` had been answered by whichever node the bridge picked,
 * started telling the operator "this node does not host the notification
 * artifact index — use the hub".
 *
 * The two are different things and only one of them is a directory:
 *
 *   INDEX  rows in the shared settings store   — every node, always
 *   SHELF  a path on somebody's disk           — one node, the one that owns it
 */
describe('the index is not the shelf', () => {
  it('the refusal is about a PATH, and says which node owns it', () => {
    const why = artifactShelfRefusal([loc({ nodeId: 'hub' })], 'agent-a')
    expect(why).toContain('artefact shelf')
    expect(why).toContain('hub')
    // It must never read as "this node cannot answer questions about
    // artefacts" — it can, from the index.
    expect(why).not.toMatch(/index/i)
  })
})
