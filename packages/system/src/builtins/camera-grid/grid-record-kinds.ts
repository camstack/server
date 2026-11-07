/**
 * A camera grid as a record (D1013): one `camera-grid` row per grid, owned by the `camera-grid`
 * builtin, listed and edited through `integration-instances` on the Camera grids page. The layout
 * (cells, frame rate, published profiles) is authored in the camera's own device details and
 * saved onto the same record.
 *
 * The record id IS the grid id the old settings list carried (a uuid), so the camera
 * `camera-grid-<id>` and everything that names it keeps its stable identity. `cameraStableId` is
 * stored only where it is not derivable from the id.
 */
import { type DefinedRecordKind, defineEntryKind, isInstanceEnabled } from '@camstack/types'
import { z } from 'zod'
import { newGridCameraStableId } from './grid-camera-declarations.js'
import { type GridCellConfig, GridCellSchema } from './grid-instances.js'

export type GridBody = {
  readonly name: string
  /** Absent means `camera-grid-<id>`. */
  readonly cameraStableId?: string | undefined
  readonly fps: number
  readonly publishedProfiles: readonly ('high' | 'mid' | 'low')[]
  readonly cells: readonly GridCellConfig[]
  /** The grid's own switch (D1013). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** Checked against the interface by its annotation: a drifted field fails the typecheck. */
export const GridBodySchema: z.ZodType<GridBody> = z.object({
  name: z.string().min(1).max(160),
  cameraStableId: z.string().min(1).max(256).optional(),
  fps: z.number().int().min(1).max(60),
  publishedProfiles: z.array(z.enum(['high', 'mid', 'low'])).max(3),
  cells: z.array(GridCellSchema).max(16),
  enabled: z.boolean().optional(),
})

export const CAMERA_GRID_KIND_NAME = 'camera-grid'

export const cameraGridKind: DefinedRecordKind<z.ZodType<GridBody>> = defineEntryKind(
  CAMERA_GRID_KIND_NAME,
  {
    title: 'Camera grids',
    nameField: 'name',
    schema: GridBodySchema,
    writeTrigger:
      'an operator adds, switches or deletes a grid, or saves its layout in the camera details',
  },
)

/** Canvas cadence and published rungs a new grid starts with, until the layout editor changes them. */
const DEFAULT_FPS = 10
const DEFAULT_PUBLISHED: readonly ('high' | 'mid' | 'low')[] = ['mid', 'low']

/** The body a new grid starts with: a name only, no cells, so it declares a camera and emits nothing. */
export function initialGridBody(name: string): GridBody {
  return { name, fps: DEFAULT_FPS, publishedProfiles: DEFAULT_PUBLISHED, cells: [] }
}

/** The row `readGridInstances` parses, from a record. */
export function rawGridOfRecord(id: string, body: GridBody): Record<string, unknown> {
  return {
    id,
    cameraStableId: body.cameraStableId ?? newGridCameraStableId(id),
    name: body.name,
    enabled: isInstanceEnabled(body),
    fps: body.fps,
    publishedProfiles: body.publishedProfiles,
    cells: body.cells,
  }
}
