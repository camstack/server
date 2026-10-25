/**
 * D475's rule, in ONE place: a camera whose `motionSources` lists anything
 * other than `'analyzer'` (firmware `onboard`, a device's own
 * `device-activity`) owns its motion through that SENSOR, and the analyzer
 * never re-describes it — even when the list carries `'analyzer'` too. A
 * camera with `['analyzer']` alone is driven by the analyzer.
 *
 * Read by the runner (which analyzer edge reaches its phase machine) and by
 * the orchestrator's camera motion slice (which motion events the slice
 * counts, D696). Two copies of the rule would be two authorities.
 */
import type { MotionSources } from '../capabilities/pipeline-runner.cap.js'

export function cameraOwnsMotionViaSensor(motionSources: MotionSources): boolean {
  return motionSources.some((s) => s !== 'analyzer')
}
