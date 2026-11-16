/**
 * A grid is a core block (planning#580): its configuration is the block's
 * `GridHelperSpec`, its camera is the composer's row `composed-<blockId>`, and
 * this engine serves the camera caps on it. The spec names its sources by
 * `(addonId, stableId)`; the compositor addresses them by device id, so a pass
 * resolves one into the other here, and a layout save resolves back.
 */
import {
  compileHelper,
  type Composition,
  type CompositionSourceRef,
  type GridCellSpec,
  type GridHelperSpec,
  type GridLayoutCell,
  type GridProfile,
} from '@camstack/types'

export type NormalizedRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One cell as the compositor reads it: a source DEVICE, the part taken, where it lands. */
export type GridCellConfig = {
  readonly deviceId: number
  readonly source: NormalizedRect
  readonly cell: NormalizedRect
}

/** What the compositor and the profile planner read of a grid. */
export interface GridComposition {
  readonly fps: number
  readonly publishedProfiles: readonly GridProfile[]
  readonly cells: readonly GridCellConfig[]
}

export function sourceRefKey(ref: CompositionSourceRef): string {
  return `${ref.addonId}\u0000${ref.stableId}`
}

/** The cells whose source resolved, and the refs that did not. */
export interface ResolvedGridCells {
  readonly cells: readonly GridCellConfig[]
  readonly unresolved: readonly CompositionSourceRef[]
}

/**
 * Resolve every cell's source to its device id. A source with no row is left
 * out of the composition and NAMED: a deleted camera must not keep the grid
 * from composing the cells that remain.
 */
export function resolveGridCells(
  spec: GridHelperSpec,
  deviceIdOf: (ref: CompositionSourceRef) => number | null,
): ResolvedGridCells {
  const cells: GridCellConfig[] = []
  const unresolved: CompositionSourceRef[] = []
  for (const cell of spec.cells) {
    const deviceId = deviceIdOf(cell.source)
    if (deviceId === null) {
      unresolved.push(cell.source)
      continue
    }
    cells.push({ deviceId, source: cell.region, cell: cell.cell })
  }
  return { cells, unresolved }
}

/** What a layout save writes: the patch, with each source device named by its identity. */
export interface GridSpecPatch {
  readonly fps?: number | undefined
  readonly publishedProfiles?: readonly GridProfile[] | undefined
  readonly cells: readonly GridLayoutCell[]
}

/**
 * The spec a layout save stores. A cell whose device has no identity is
 * refused by id: a saved spec must never carry a numeric device id.
 */
export function gridSpecFromPatch(
  current: GridHelperSpec,
  patch: GridSpecPatch,
  refOf: (deviceId: number) => CompositionSourceRef | null,
): GridHelperSpec {
  const cells: GridCellSpec[] = patch.cells.map((cell) => {
    const source = refOf(cell.deviceId)
    if (source === null) {
      throw new Error(`camera-grid: source device ${String(cell.deviceId)} does not exist`)
    }
    return { source, region: cell.source, cell: cell.cell }
  })
  return {
    kind: 'grid',
    fps: patch.fps ?? current.fps,
    publishedProfiles: patch.publishedProfiles ?? current.publishedProfiles,
    cells,
  }
}

/** The composition a grid spec compiles to — the shape a block of this kind stores. */
export function gridComposition(spec: GridHelperSpec): Composition {
  const compiled = compileHelper(spec)
  if (!compiled.ok) {
    throw new Error(
      `camera-grid: the grid spec does not compile — ${compiled.problems.map((p) => p.message).join('; ')}`,
    )
  }
  return compiled.composition
}
