/**
 * The composition, driven by the OUTPUT's clock.
 *
 * ## What this replaces, and why it is the only thing that works
 *
 * `overlay` pairs its inputs BY PTS and ffmpeg gives each input pts 0 at its
 * own first frame, so two sources that joined at different moments compose
 * different moments for the life of the child. Measured at 4-5 s on this hub,
 * drifting over hours as the sources' key-frame phases slide through each other.
 * Every cheaper fix was tried and measured: `-use_wallclock_as_timestamps`
 * re-times by arrival and wrecked the pacing; `-copyts` changes nothing because
 * the broker re-bases each session (both restreams report `pts_time:0`), so
 * there is no shared timeline to align against; and serving each dial from the
 * newest key frame it already holds only moves the offsets into the past,
 * because those key frames are of different ages.
 *
 * Here there is nothing to pair. Every tick asks each source "what do you look
 * like NOW" and the answer is whatever arrived last. The gap is zero by
 * construction rather than by tuning.
 *
 * ## It also removes the wait
 *
 * A cell with no frame yet is not a reason to hold the picture back. The output
 * exists from the first tick and cells fill in as their sources arrive —
 * instead of the whole grid waiting for the slowest source's first key frame,
 * which is what the ~9 s cold start was.
 *
 * What a cell with no frame yet SHOWS is the seed (`grid-canvas-seed.ts`),
 * blitted in once at construction: its own rectangle, with its camera's name
 * and the word `Waiting`. It was black, and black said the same thing about an
 * empty grid, a broken grid and a grid that is merely still opening.
 *
 * ## What it costs
 *
 * The same N decodes ffmpeg already paid, in N children instead of one, plus
 * one strided memcpy per tile per tick (`grid-canvas.ts`). It does NOT reuse the
 * frames the detection pipeline decodes: those live in per-session decode
 * workers behind two process boundaries, the shm plane that once joined them was
 * removed on 2026-07-16, and what the pipeline retains is a model-sized view
 * (320x180 JPEG, on demand), not a tile.
 */
import { GridCanvas } from './grid-canvas.js'
import { GridTileFeed } from './grid-tile-feed.js'
import type { GridTile, GridTilePlan } from './grid-tile-plan.js'

export interface GridCompositorDeps {
  readonly plan: GridTilePlan
  /**
   * Hand one composed frame to the encoder. `false` means the sink is not
   * draining — the caller slows down rather than queueing raw frames, which at
   * 345 KB each is how a stalled encoder becomes an OOM.
   */
  readonly write: (frame: Buffer) => boolean
  /**
   * The picture the canvas carries before any tile has arrived — one card per
   * cell, naming its camera (`grid-canvas-seed.ts`). `null` ⇒ black, which is
   * what this was before the seed and what it falls back to when the seed
   * cannot be drawn.
   *
   * Blitted ONCE, here, so the very first tick already carries it: the tick
   * serves every cell and must never wait on a render.
   */
  readonly seed: Buffer | null
}

interface Placed {
  readonly tile: GridTile
  readonly feed: GridTileFeed
}

export class GridCompositor {
  private readonly canvas: GridCanvas
  /** Keyed by tile id — unique per CELL, because one camera can hold two. */
  private readonly placed = new Map<string, Placed>()
  private closed = false

  constructor(private readonly deps: GridCompositorDeps) {
    this.canvas = new GridCanvas(deps.plan.canvas.width, deps.plan.canvas.height)
    if (deps.seed !== null) {
      // A seed the canvas refuses is simply not painted — the picture is black,
      // which is what it was before. It must never be a reason not to compose.
      this.canvas.blit(deps.seed, deps.plan.canvas, { x: 0, y: 0 })
    }
    for (const tile of deps.plan.tiles) {
      this.placed.set(tile.id, { tile, feed: new GridTileFeed(tile.frameBytes) })
    }
  }

  /**
   * Raw bytes from one decoder output.
   *
   * A tile this composition has no rectangle for is IGNORED, never thrown on: a
   * child that outlives a layout change would otherwise take the tick down with
   * it, and the tick is what every other cell depends on.
   */
  onTile(tileId: string, chunk: Buffer): void {
    this.placed.get(tileId)?.feed.push(chunk)
  }

  /**
   * Compose and emit one frame. Returns what the sink said about back-pressure.
   *
   * Every tile is redrawn, fresh or not: a tile that produced nothing this tick
   * is a still picture, not a hole, and clearing it would make a late source
   * flicker. The canvas is never cleared between ticks for the same reason.
   */
  tick(): boolean {
    if (this.closed) return true
    for (const { tile, feed } of this.placed.values()) {
      const frame = feed.latest()
      if (frame === null) continue
      // A blit that does not fit is dropped for THIS tile only. It cannot be a
      // throw: the tick serves every other cell too.
      this.canvas.blit(frame, tile.size, tile.origin)
    }
    return this.deps.write(this.canvas.buffer)
  }

  /**
   * A tile's decoder was replaced: drop its half frame, keep its picture.
   *
   * Without this the new decoder's bytes would be appended to the old one's
   * partial frame and every frame after would be sheared — raw video has no
   * framing to re-sync on.
   */
  resetTile(tileId: string): void {
    this.placed.get(tileId)?.feed.resetPartial()
  }

  /** After this, a tick emits nothing — a dead child must not keep writing. */
  close(): void {
    this.closed = true
  }
}
