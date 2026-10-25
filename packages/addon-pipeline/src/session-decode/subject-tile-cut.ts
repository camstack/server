/**
 * Cutting a frame's subject tiles: read ALL the pixels first, encode after.
 *
 * ## The race this removes
 *
 * `handleCutTiles` held a JS reference to the retained frame across the `await`
 * of every subject's JPEG encode. A JPEG encode is real async work, so the
 * worker services more IPC while it runs — and the message it is most likely to
 * service is a `pull`, whose delivered frame reaches `captureNativeFrame` →
 * `NativeLeaseStore.put`, which EVICTS the oldest held frame to stay inside
 * `holdFrames` / the byte budget. On a busy camera the oldest held frame is
 * exactly the one being cut.
 *
 * Live on dev:1443 (hub runner) that produced
 * `retained frame in unsupported pixel format -1 (planes=0, hw=false)` — a node-av
 * frame whose `free()` had already run: AV_PIX_FMT_NONE, zero planes. The tier
 * had been cutting tiles for the first subject of each frame and losing the rest.
 *
 * ## Why the fix is ordering, not detection
 *
 * A liveness check before each read only narrows the window; it cannot close it,
 * because the eviction happens between turns and a check is not a lock. What
 * closes it is that **every pixel read happens in one synchronous turn**:
 * {@link extractSubjectTiles} cannot await, so no free can interleave with it —
 * a free would have to run on this same thread. The encode phase then works
 * from COPIED bytes and no longer cares whether the frame is alive.
 *
 * That also answers whether a generation/sequence number is needed to stop a cut
 * from silently producing another frame's pixels. It is not, on two independent
 * grounds: the store is keyed by a monotonic `frameId` and `drop()` removes the
 * entry in the same statement that frees it, so `get(frameId)` can never hand
 * back a recycled frame under an id it did not belong to; and there is no longer
 * a window in which the frame under a held reference can change at all. The
 * liveness check that remains is a cheap assertion of that invariant, not the
 * mechanism — and because it is checked before EVERY read, a future edit that
 * reintroduces an await inside the loop degrades to a counted miss instead of a
 * read of recycled memory.
 *
 * ## What it costs
 *
 * The raw subject rasters live in RAM until their encodes finish, instead of one
 * at a time. Bounded by the caller's per-frame subject cap (`NATIVE_TILE_MAX_PER_FRAME`)
 * times one padded subject rectangle — tens of MB in the worst case on 4K, for
 * milliseconds — against a full retained raster of ~24.9 MB on 4K, which the
 * hold is paying for anyway until the release that follows.
 *
 * Generic over the frame type so the ordering is unit-testable without node-av.
 */

import type { ResolvedRegion } from './crop-geometry.js'
import type { NativeTile } from './native-tile-store.js'
import type { NormalizedBbox } from './worker-protocol.js'

/** One subject's pixels, copied out of the retained frame and owned by us. */
export interface RawSubjectTile {
  /** The tile's placement in the SOURCE frame, in native pixels. */
  readonly region: ResolvedRegion
  /** Raw (unencoded) tile raster. */
  readonly raw: Uint8Array
}

/** Everything the cut needs from the worker, injected so the ordering is testable. */
export interface SubjectTileCutPorts<F> {
  /** Is this retained frame still backed by pixels? Checked before every read. */
  isLive(frame: F): boolean
  /** Copy ONE subject's pixels out of the frame. Synchronous by contract. */
  cutRaw(frame: F, bbox: NormalizedBbox): RawSubjectTile
  /** Compress one copied raster. Async — runs only after every read is done. */
  encode(tile: RawSubjectTile): Promise<NativeTile>
  /** The frame died before (or during) extraction — reported ONCE per cut. */
  onFrameLost(): void
  /** One subject failed, for a reason of its own. Every one is counted. */
  onCutFailed(reason: string): void
}

function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Copy every subject's pixels out of `frame`. SYNCHRONOUS on purpose — see the
 * module docblock; adding an `await` here reopens the race this closes.
 *
 * Liveness is re-checked before EVERY read and the loop STOPS at the first
 * failed check: once a frame has been freed, the remaining subjects are lost
 * regardless, and there is nothing to gain from asking again per subject.
 * `onFrameLost` therefore fires at most once.
 */
export function extractSubjectTiles<F>(
  frame: F,
  bboxes: readonly NormalizedBbox[],
  ports: SubjectTileCutPorts<F>,
): RawSubjectTile[] {
  const raws: RawSubjectTile[] = []
  for (const bbox of bboxes) {
    if (!ports.isLive(frame)) {
      ports.onFrameLost()
      return raws
    }
    try {
      raws.push(ports.cutRaw(frame, bbox))
    } catch (err) {
      // An operational failure — a bad geometry, an sws error. It costs its own
      // subject and nothing else, which is the pre-existing behaviour.
      ports.onCutFailed(failureReason(err))
    }
  }
  return raws
}

/**
 * Cut and encode one frame's subject tiles.
 *
 * Two phases, and the boundary between them is the whole point: extraction
 * (synchronous, touches the frame) then encoding (async, touches only copies).
 *
 * The hold is deliberately NOT ended at that boundary, tempting as it looks: the
 * tiles are not stored until the encodes finish, so releasing the raster early
 * would open a window in which a crop request for this frame can be served by
 * neither the lease nor a tile. That window is small and the RAM it would buy
 * back is one frame for a few milliseconds — a bad trade against a miss, which
 * is the failure this whole tier exists to remove. The caller releases once,
 * after the tiles are in the store.
 */
export async function cutSubjectTiles<F>(
  frame: F,
  bboxes: readonly NormalizedBbox[],
  ports: SubjectTileCutPorts<F>,
): Promise<NativeTile[]> {
  const raws = extractSubjectTiles(frame, bboxes, ports)
  const tiles: NativeTile[] = []
  for (const raw of raws) {
    try {
      tiles.push(await ports.encode(raw))
    } catch (err) {
      ports.onCutFailed(failureReason(err))
    }
  }
  return tiles
}
