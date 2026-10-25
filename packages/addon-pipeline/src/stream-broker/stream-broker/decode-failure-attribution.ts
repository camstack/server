/**
 * Was the hardware decoder actually at fault?
 *
 * The egress child is spawned with `-hwaccel <backend>`, and until now ANY
 * failure of that first attempt was read as "hardware produced no packets":
 * the child was retried in software and the backend was quarantined for thirty
 * minutes, process-wide, for every camera.
 *
 * Measured on the hub 2026-09-13 at 17:48, the failure that triggered a
 * quarantine was this:
 *
 * ```
 *   17:48:43  egress: spawning ffmpeg child (hwaccel vaapi)
 *   17:48:45  native:sub — dial rate-limited, deferring to backoff window
 *   17:48:46  child FAILED: Error opening input: Invalid data found …
 *   17:48:49  rfc4571: publisher materialized {materializeMs=5486}
 * ```
 *
 * The child was started three seconds before anything was publishing to the
 * RTSP endpoint it was told to read. It never reached a decoder at all — and
 * the decoder took the blame, and every other camera lost hardware decode for
 * half an hour.
 *
 * ## The direction of the doubt
 *
 * An UNRECOGNISED failure still blames the backend. That asymmetry is
 * deliberate: a wrong quarantine costs software decode, while a missed one
 * costs every session a three-second death before its own retry — seven times
 * on one camera in half an hour, which is what put the quarantine here in the
 * first place. Only a failure we can positively attribute elsewhere is
 * excused.
 */

/** Shapes only a decode backend produces. */
const BACKEND_FAILURE = [
  /device creation failed/i,
  /failed to create .*(vaapi|qsv|cuda|videotoolbox|drm) .*device/i,
  /no va display/i,
  /hwaccel .*(not|un)(supported|available)/i,
  /cannot open the .*(hardware|hw) device/i,
  /impossible to convert between the formats/i,
]

/**
 * Shapes that are NOT the decoder's — checked FIRST, because the argv always
 * names the backend and a substring match on its name would convict it of
 * every failure ever logged.
 */
const NOT_BACKEND = [
  /error opening input/i,
  /invalid data found when processing input/i,
  /connection refused/i,
  /connection timed out/i,
  /server returned \d/i,
  /no route to host/i,
  /immediate exit requested/i,
  /end of file/i,
]

export function isDecodeBackendFailure(error: string): boolean {
  if (NOT_BACKEND.some((re) => re.test(error))) return false
  if (BACKEND_FAILURE.some((re) => re.test(error))) return true
  // Unattributable: blame the backend. See the header.
  return true
}
