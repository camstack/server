/**
 * Creation is NAME ONLY.
 *
 * The operator adds a row on the integration page and types a name. Everything
 * else — the identity the rest of the cluster will reference forever, the
 * canvas, the frame rate, the cells — is filled in here on the way past, and
 * then edited in the camera's own device details.
 *
 * This runs BEFORE `readGridInstances`, which deliberately IGNORES a row it
 * cannot parse so one bad row can never make the declaration reconcile
 * destructive. A freshly typed name is exactly such a row, so without this step
 * a new grid would be silently discarded at the moment of creation.
 */
import { newGridCameraStableId } from './grid-camera-declarations.js'

/** Canvas and cadence a grid starts life with, until the layout editor changes them. */
const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FPS = 10

export interface NormalizedGridRows {
  readonly rows: readonly Record<string, unknown>[]
  /** `true` when the rows differ from what was read, i.e. they must be persisted. */
  readonly changed: boolean
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * @param mintId a UUID factory — injected so the normalization is testable
 * without reaching for `crypto`.
 */
export function normalizeGridRows(
  raw: readonly Record<string, unknown>[],
  mintId: () => string,
): NormalizedGridRows {
  let changed = false
  const rows: Record<string, unknown>[] = []
  for (const row of raw) {
    const name = nonEmptyString(row['name'])
    if (name === null) {
      // A nameless row would declare a camera nobody can identify in a list.
      // Dropping it is the same discipline `readGridInstances` applies.
      changed = true
      continue
    }
    const id = nonEmptyString(row['id']) ?? mintId()
    // A stable id is PERMANENT once minted — bindings, layouts and this
    // addon's own tombstones reference it. An existing one is never re-derived.
    const cameraStableId = nonEmptyString(row['cameraStableId']) ?? newGridCameraStableId(id)
    const normalized: Record<string, unknown> = {
      ...row,
      id,
      cameraStableId,
      name,
      enabled: typeof row['enabled'] === 'boolean' ? row['enabled'] : true,
      width: positiveInt(row['width'], DEFAULT_WIDTH),
      height: positiveInt(row['height'], DEFAULT_HEIGHT),
      fps: positiveInt(row['fps'], DEFAULT_FPS),
      cells: Array.isArray(row['cells']) ? row['cells'] : [],
    }
    if (!changed) {
      changed = Object.keys(normalized).some((key) => normalized[key] !== row[key])
    }
    rows.push(normalized)
  }
  return { rows, changed }
}
