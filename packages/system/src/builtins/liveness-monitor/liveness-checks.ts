/**
 * The liveness invariants, as pure functions.
 *
 * On 2026-08-03 the hub ran for four hours with zero devices, zero published
 * streams and zero recordings, and nothing said a word. Three separate defects
 * caused it — optional chaining that no-oped, an `if` with no `else`, a JSON
 * parse that returned `{}` — and each was silent at the point of failure. All
 * three were fixed and a log line added at each. This module exists for the
 * CLASS rather than the instances: assert what must be true of a working node,
 * and report when it is not.
 *
 * **Every check here is unambiguous, on purpose.** An alert that fires on a
 * quiet night is one an operator learns to ignore, and an ignored alert is
 * worse than no alert. So "the pipeline emitted no tracks recently" is NOT a
 * check — a camera can legitimately see nothing for hours — while "a camera
 * that has been recording all day stopped producing segments" is: continuous
 * recording produces segments whether or not anything moves.
 *
 * I/O lives in the addon; everything here is a function of facts, so the
 * outage can be replayed in a test.
 */

import type { RecordingStatus } from '@camstack/types'

/** The recording mode a camera is running under, as `recording.getStatus` reports it. */
export type RecordingActiveMode = RecordingStatus['activeMode']

/** What the monitor learned about one camera this tick. */
export interface CameraFootage {
  readonly deviceId: number
  /**
   * Operator-facing name. Prefer this in the finding message; the numeric id
   * stays on `deviceId` for tags / stable finding ids.
   */
  readonly name?: string
  readonly online: boolean
  /**
   * ms-epoch of the newest recorded segment within the lookback window, or
   * `null` when the camera has produced NO footage in it.
   *
   * `null` means "this camera does not record" and is deliberately not a
   * finding — it is what makes the check self-calibrating. Nothing has to be
   * told which cameras are supposed to record: a camera that was recording and
   * stopped is a fault, a camera that never records is a configuration.
   */
  readonly lastSegmentMs: number | null
  /**
   * The recording mode the camera runs under, asked only when it looks silent
   * (`null` = not asked, the footage was recent). Silence is a fault ONLY for a
   * `continuous` recorder: an `events` recorder that has seen nothing move is
   * doing its job, and `off` is the operator's own switch. Seven events-mode
   * cameras alerted for a whole quiet night on 2026-09-06.
   */
  readonly activeMode: RecordingActiveMode | null
}

export interface LivenessFacts {
  readonly nowMs: number
  /** Every device the node knows about, cameras and accessories alike. */
  readonly deviceCount: number
  readonly cameras: readonly CameraFootage[]
  /** How long a recording camera may stay silent before it is a fault. */
  readonly staleAfterMs: number
}

export interface LivenessFinding {
  /**
   * Stable across ticks, so an ongoing fault UPDATES one alert instead of
   * producing a new one every minute. Same contract as the kernel's
   * `addon-load-failed:<packageName>` ids.
   */
  readonly id: string
  readonly severity: 'error' | 'warning'
  readonly title: string
  readonly message: string
  /** Present on per-camera findings. Always the numeric id. */
  readonly deviceId?: number
  /** Operator name when known — alert surfaces prefer this over the id. */
  readonly deviceName?: string
}

const NO_DEVICES = 'liveness:no-devices'
const ALL_OFFLINE = 'liveness:all-devices-offline'
const NO_FOOTAGE_PREFIX = 'liveness:no-footage:'

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

/**
 * Evaluate every invariant against one tick's facts.
 *
 * Ordered most-fundamental first, and it STOPS at "no devices": when the node
 * has nothing, every camera is also silent, and reporting twelve consequences
 * of one cause is how an operator ends up reading none of them.
 */
export function evaluateLiveness(facts: LivenessFacts): readonly LivenessFinding[] {
  if (facts.deviceCount === 0) {
    return [
      {
        id: NO_DEVICES,
        severity: 'error',
        title: 'No devices',
        message:
          'This node has no devices. Nothing can publish a stream, record, or detect. ' +
          'The persisted device ledger is either unreachable or empty — check the boot log ' +
          'for "SettingsStore not initialized" and for "[worker-restore] no persisted devices".',
      },
    ]
  }

  const findings: LivenessFinding[] = []

  if (facts.cameras.length > 0 && facts.cameras.every((c) => !c.online)) {
    findings.push({
      id: ALL_OFFLINE,
      severity: 'error',
      title: 'Every camera offline',
      message: `All ${facts.cameras.length} cameras report offline. This is a provider or network fault, not a per-camera one.`,
    })
  }

  for (const cam of facts.cameras) {
    // No footage in the whole window: the camera does not record. Not a fault.
    if (cam.lastSegmentMs === null) continue
    // Offline is already its own reported fact; do not report it twice.
    if (!cam.online) continue
    const silentFor = facts.nowMs - cam.lastSegmentMs
    if (silentFor <= facts.staleAfterMs) continue
    // Only a continuous recorder is expected to produce footage unprompted.
    if (cam.activeMode !== null && cam.activeMode !== 'continuous') continue
    const label =
      typeof cam.name === 'string' && cam.name.trim().length > 0
        ? cam.name.trim()
        : `Camera ${String(cam.deviceId)}`
    findings.push({
      id: `${NO_FOOTAGE_PREFIX}${cam.deviceId}`,
      severity: 'error',
      title: 'Recording stopped',
      message: `${label} is online and was recording, but has produced no segment for ${minutes(silentFor)} minutes.`,
      deviceId: cam.deviceId,
      ...(typeof cam.name === 'string' && cam.name.trim().length > 0
        ? { deviceName: cam.name.trim() }
        : {}),
    })
  }

  return findings
}

/** Every finding id this module can produce, for the recovery sweep. */
export function isLivenessFindingId(id: string): boolean {
  return id === NO_DEVICES || id === ALL_OFFLINE || id.startsWith(NO_FOOTAGE_PREFIX)
}
