import type { SirenOptions } from '@camstack/types'

/**
 * The Hikvision siren is driven by holding an alarm input: the camera's
 * Linkage Method plays the tone while the input is active, and the accessory
 * releases the input after the requested time. So the duration is real seconds
 * under our control, bounded by the pulse limits — not a play count.
 *
 * `source` is `camera` only when the probe confirmed the alarm input port
 * (`/ISAPI/System/IO/inputs` listed it); otherwise the bounds are the
 * documented fallback and say so.
 */
export const HIKVISION_SIREN_MIN_SECONDS = 1
export const HIKVISION_SIREN_MAX_SECONDS = 600
export const HIKVISION_SIREN_STEP_SECONDS = 1

export function buildHikvisionSirenOptions(input: {
  readonly pulseDurationMs: number
  readonly portConfirmedByCamera: boolean
  readonly nowMs: number
}): SirenOptions {
  const configured = Math.round(input.pulseDurationMs / 1000)
  const defaultSeconds = Math.min(
    HIKVISION_SIREN_MAX_SECONDS,
    Math.max(HIKVISION_SIREN_MIN_SECONDS, configured),
  )
  return {
    allowedSeconds: null,
    rangeSeconds: {
      min: HIKVISION_SIREN_MIN_SECONDS,
      max: HIKVISION_SIREN_MAX_SECONDS,
      step: HIKVISION_SIREN_STEP_SECONDS,
    },
    defaultSeconds,
    unit: 'seconds',
    secondsPerPlay: null,
    source: input.portConfirmedByCamera ? 'camera' : 'fallback',
    fetchedAt: input.nowMs,
  }
}
