/**
 * What `buildHksvRecording` DECIDED for one camera, kept so the clip source can
 * say why a camera has no clips.
 *
 * ## Why this exists at all
 *
 * HomeKit Secure Video is advertised for a camera only if a recordable stream
 * could be picked: `pickRecordingSource` refuses anything without an H.264
 * slot, `MAX_RECORDING_HEIGHT` prefers ≤ 1080p, and `deriveFragmentLengthMs`
 * refuses a key-frame interval longer than any fragment length we advertise.
 * Each refusal is already logged with `tags: { deviceId }` — and a log line is
 * not an answer to a surface. A camera whose switch says RECORD and whose clip
 * store holds nothing is a CONTRADICTION, and the only honest thing the clip
 * source can do is name which of those three fired ({@link HksvWithholdReason}).
 * Without it the source would answer "no clips" for a camera HomeKit was never
 * able to record — the one sentence the whole external-clip line of work exists
 * to stop a surface from having to guess (D549, D561).
 *
 * ## It is a MIRROR, not a second authority
 *
 * The authority is the build itself, and this is written by it at the moment it
 * decides, on the one path that decides (`buildHksvRecording`). Nothing reads
 * it to make a decision; it is reported and nothing else. It is process-local
 * and a restart empties it — a camera whose accessory has not been (re)built in
 * this process has `null`, which the source reports as "not established", never
 * as a refusal that did not happen (D561: a probe that has not run is not a
 * state).
 */

/** Which of `buildHksvRecording`'s refusals withheld the advertisement. */
export type HksvWithholdReason =
  /** `cameraStreams.getProfileRtspEntries` could not be read at all. */
  | 'profiles-unreadable'
  /** `pickRecordingSource` found no H.264 slot it could copy (≤ 1080p). */
  | 'no-recordable-stream'
  /** The camera's GOP is longer than any fragment length we advertise. */
  | 'key-frame-interval'

export interface HksvBuildOutcome {
  readonly deviceId: number
  /** True when the accessory really carries the recording services. */
  readonly advertised: boolean
  /** `null` exactly when {@link advertised} is true. */
  readonly withheld: HksvWithholdReason | null
  /** The camera's own numbers, verbatim — `gopMs=12000`, the refusal token. */
  readonly detail: string | null
  readonly atMs: number
}

/**
 * Every camera's last build verdict, in this process.
 *
 * A `Map` behind a named type rather than a bare one, because the thing that
 * matters about it is what `get` returning `undefined` MEANS: not "recording is
 * fine", but "no accessory has been built for this camera since the addon
 * started".
 */
export class HksvBuildOutcomes {
  private readonly byDevice = new Map<number, HksvBuildOutcome>()

  note(outcome: HksvBuildOutcome): void {
    this.byDevice.set(outcome.deviceId, outcome)
  }

  /** `null` when nothing has been established for this camera yet. */
  lastFor(deviceId: number): HksvBuildOutcome | null {
    return this.byDevice.get(deviceId) ?? null
  }

  /** The camera left HomeKit: its verdict is not a fact about anything now. */
  forget(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }
}
