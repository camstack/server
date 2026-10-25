/**
 * The operator-written grid rows.
 *
 * Shape follows `readTerminalInstances`: a grid is a persisted row that
 * DECLARES a camera, and the declaration reconcile turns rows into devices.
 *
 * Config is operator-writable, so a malformed or duplicate row is IGNORED
 * rather than allowed to make the reconcile destructive. One bad row must never
 * delete every camera this addon declares — that failure mode is why the
 * Terminal addon reads its rows the same way.
 */
import { z } from 'zod'

type NormalizedRect = {
  x: number
  y: number
  width: number
  height: number
}

/** A rectangle in normalized [0,1] coordinates of whatever contains it. */
const NormalizedRectSchema: z.ZodType<NormalizedRect> = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

export type GridCellConfig = {
  deviceId: number
  source: NormalizedRect
  cell: NormalizedRect
}

/**
 * One source camera, the part of its picture taken, and where that part lands
 * on the composite's canvas. Both rectangles are NORMALIZED so a source that
 * changes resolution does not silently start cutting the wrong region.
 */
const GridCellSchema: z.ZodType<GridCellConfig> = z.object({
  deviceId: z.number().int().positive(),
  source: NormalizedRectSchema,
  cell: NormalizedRectSchema,
})

export type GridInstance = {
  id: string
  cameraStableId: string
  name: string
  enabled: boolean
  fps: number
  publishedProfiles: Array<'high' | 'mid' | 'low'>
  cells: GridCellConfig[]
}

const GridInstanceSchema: z.ZodType<GridInstance> = z.object({
  id: z.string().uuid(),
  cameraStableId: z.string().min(1).max(256),
  name: z.string().min(1).max(160),
  enabled: z.boolean(),
  /**
   * NO canvas size. It is DERIVED, per profile, from the cells and the sources'
   * own dimensions (`grid-canvas-derivation.ts`) — the two numbers that used to
   * live here were typed into the editor and silently decided both how much the
   * composite cost and how sharp it was.
   *
   * Rows written before that change still carry `width`/`height`; zod drops
   * unknown keys, so they are ignored rather than migrated. Nothing reads them,
   * and a migration that rewrote every row to delete two fields would be a
   * write with no reader.
   */
  fps: z.number().int().min(1).max(60),
  /**
   * Which profiles this grid PUBLISHES, of the ones it could serve.
   *
   * Default `mid` + `low`, and the default is the finding: a grid's `high` is
   * composed of its sources' `high`, so on this fleet it is a 4K canvas built
   * from 4K decodes — a thing to opt into, not to be handed by a viewer's
   * adaptive climbing to the top rung it can see.
   *
   * Absent on rows written before this, which is why the default lives in the
   * schema rather than at the call site: an old grid starts publishing the two
   * cheap rungs without anyone touching it.
   */
  publishedProfiles: z
    .array(z.enum(['high', 'mid', 'low']))
    .max(3)
    .default(['mid', 'low']),
  /**
   * Empty is the NORMAL freshly-created state: a grid is created from the
   * integration page with a name only, and laid out afterwards in the camera's
   * own settings. A grid with no cells declares its camera and emits nothing.
   */
  cells: z.array(GridCellSchema).max(16).default([]),
})

export function readGridInstances(
  raw: readonly Record<string, unknown>[],
  onInvalid?: (message: string) => void,
): readonly GridInstance[] {
  const ids = new Set<string>()
  const stableIds = new Set<string>()
  const instances: GridInstance[] = []
  for (const value of raw) {
    const parsed = GridInstanceSchema.safeParse(value)
    if (!parsed.success) {
      onInvalid?.('Ignoring malformed camera-grid configuration')
      continue
    }
    const instance = parsed.data
    if (ids.has(instance.id) || stableIds.has(instance.cameraStableId)) {
      onInvalid?.(`Ignoring duplicate camera-grid instance ${instance.id}`)
      continue
    }
    ids.add(instance.id)
    stableIds.add(instance.cameraStableId)
    instances.push(instance)
  }
  return instances
}
