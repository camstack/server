/**
 * Which larger detector can pre-annotate a frame as a "teacher".
 *
 * Read from the catalog of the node that will run it (`pipelineExecutor.
 * getSchema`), never typed here: a teacher must have a build for the format
 * that node dispatches on, or the node refuses the pin (`model-not-servable`).
 * Hidden (legacy) catalog entries are not offered — the executor resolves a
 * hidden model to the format default, so a pin on one is refused too.
 *
 * "Larger" is measured by the build's size on that format, the one number the
 * catalog carries for every model: a teacher smaller than the camera's own
 * detector would teach it nothing.
 */
import type { PipelineSchema } from '@camstack/types'
import { OBJECT_DETECTION_STEP_ID } from './retrain-assist-defaults.js'

export interface TeacherCandidate {
  readonly modelId: string
  readonly name: string
  readonly sizeMB: number
}

/** A teacher proposes more than production: its own floor is lower. */
export const TEACHER_DEFAULT_MIN_SCORE = 0.25

/** The detectors on this node larger than the camera's, largest first. */
export function teacherCandidates(
  schema: PipelineSchema | undefined,
  cameraModelId: string | undefined,
): readonly TeacherCandidate[] {
  if (schema === undefined) return []
  const format = schema.selectedEngine.format
  const catalog = schema.slots
    .flatMap((slot) => slot.addons)
    .find((addon) => addon.id === OBJECT_DETECTION_STEP_ID)
  if (catalog === undefined) return []
  const sized = catalog.models
    .filter((m) => m.legacy !== true && m.provider === undefined)
    .flatMap((m): TeacherCandidate[] => {
      const build = m.formats[format]
      return build === undefined ? [] : [{ modelId: m.id, name: m.name, sizeMB: build.sizeMB ?? 0 }]
    })
  const own = sized.find((c) => c.modelId === cameraModelId)
  return sized
    .filter((c) => c.modelId !== cameraModelId && (own === undefined || c.sizeMB > own.sizeMB))
    .toSorted((a, b) => b.sizeMB - a.sizeMB)
}
