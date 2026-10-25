/**
 * Privacy-mask rect ↔ cell rasterizer.
 *
 * Converts between a list of normalized axis-aligned rectangles
 * (the native camera representation) and a row-major boolean cell grid
 * (the cap model). All coordinates are in [0, 1] normalized space
 * where (0, 0) is top-left.
 *
 * These utilities are pure functions with no side effects — safe to use
 * in any addon without cross-process concerns.
 */

/** Normalized axis-aligned rect: origin (x, y), size (w, h). All values in [0, 1]. */
export interface NormRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Rasterize a list of normalized rects into a row-major boolean cell grid.
 *
 * Each cell at grid position (col, row) has its centre at:
 *   cx = (col + 0.5) / gridWidth
 *   cy = (row + 0.5) / gridHeight
 *
 * A cell is `true` when its centre falls inside any rect (closed interval
 * on all four edges so single-pixel-wide rects always activate the cell
 * whose centre is nearest the edge).
 *
 * Returns an array of length `gridWidth * gridHeight` in row-major order.
 * Returns all-false when `rects` is empty or grid dimensions are ≤ 0.
 */
export function rectsToCells(
  rects: readonly NormRect[],
  gridWidth: number,
  gridHeight: number,
): boolean[] {
  const total = gridWidth * gridHeight
  if (total <= 0 || rects.length === 0) {
    return Array.from<boolean>({ length: Math.max(0, total) }).fill(false)
  }

  const cells: boolean[] = Array.from<boolean>({ length: total }).fill(false)

  for (let row = 0; row < gridHeight; row++) {
    for (let col = 0; col < gridWidth; col++) {
      const cx = (col + 0.5) / gridWidth
      const cy = (row + 0.5) / gridHeight
      for (const rect of rects) {
        if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
          cells[row * gridWidth + col] = true
          break
        }
      }
    }
  }

  return cells
}

/**
 * Convert a row-major boolean cell grid back into normalized rects, capped at
 * `maxRegions`.
 *
 * The algorithm performs a greedy maximal-rectangle cover:
 * 1. Scans row by row to identify horizontal runs of `true` cells.
 * 2. Merges vertically adjacent runs with the same column span.
 * 3. Returns each resulting block as a normalized `NormRect`.
 * 4. When more than `maxRegions` blocks result, keeps the `maxRegions`
 *    largest (by cell area).
 *
 * Returns an empty array for an empty grid or all-false cells.
 */
export function cellsToRects(
  cells: readonly boolean[],
  gridWidth: number,
  gridHeight: number,
  maxRegions: number,
): NormRect[] {
  if (gridWidth <= 0 || gridHeight <= 0 || maxRegions <= 0) return []

  const expected = gridWidth * gridHeight
  // Work with a defensive copy padded/clamped to the expected length.
  const grid: boolean[] = Array.from<boolean>({ length: expected }).fill(false)
  const copyLen = Math.min(cells.length, expected)
  for (let i = 0; i < copyLen; i++) {
    grid[i] = cells[i] === true
  }

  // Collect raw rectangular blocks via the row-run merge approach.
  // Each entry in `pending` tracks a run that has been started but not yet closed.
  interface PendingBlock {
    readonly colStart: number
    readonly colEnd: number
    readonly rowStart: number
  }

  const blocks: Array<{ colStart: number; colEnd: number; rowStart: number; rowEnd: number }> = []
  const pending: PendingBlock[] = []

  for (let row = 0; row <= gridHeight; row++) {
    // Build the set of runs on this row (sentinel row beyond the grid terminates all pending).
    const rowRuns: Array<{ colStart: number; colEnd: number }> = []
    if (row < gridHeight) {
      let runStart = -1
      for (let col = 0; col <= gridWidth; col++) {
        const active = col < gridWidth && grid[row * gridWidth + col] === true
        if (active && runStart === -1) {
          runStart = col
        } else if (!active && runStart !== -1) {
          rowRuns.push({ colStart: runStart, colEnd: col - 1 })
          runStart = -1
        }
      }
    }

    // Match pending blocks against this row's runs.
    const matched = new Set<number>() // indices into rowRuns that were matched
    const nextPending: PendingBlock[] = []

    for (const pb of pending) {
      // Find a run whose column span exactly matches the pending block.
      const idx = rowRuns.findIndex((r) => r.colStart === pb.colStart && r.colEnd === pb.colEnd)
      if (idx >= 0) {
        // Run continues — keep the block pending.
        nextPending.push(pb)
        matched.add(idx)
      } else {
        // No matching run — close the pending block at the previous row.
        blocks.push({ ...pb, rowEnd: row - 1 })
      }
    }

    // Any run on this row that didn't match an existing pending block starts a new block.
    for (let i = 0; i < rowRuns.length; i++) {
      if (!matched.has(i)) {
        const rr = rowRuns[i]!
        nextPending.push({ colStart: rr.colStart, colEnd: rr.colEnd, rowStart: row })
      }
    }

    pending.length = 0
    for (const p of nextPending) pending.push(p)
  }

  if (blocks.length === 0) return []

  // Sort by descending cell area, keep top maxRegions.
  const sorted = blocks.slice().toSorted((a, b) => {
    const aArea = (a.colEnd - a.colStart + 1) * (a.rowEnd - a.rowStart + 1)
    const bArea = (b.colEnd - b.colStart + 1) * (b.rowEnd - b.rowStart + 1)
    return bArea - aArea
  })

  const kept = maxRegions > 0 ? sorted.slice(0, maxRegions) : sorted

  return kept.map((block) => ({
    x: block.colStart / gridWidth,
    y: block.rowStart / gridHeight,
    w: (block.colEnd - block.colStart + 1) / gridWidth,
    h: (block.rowEnd - block.rowStart + 1) / gridHeight,
  }))
}
