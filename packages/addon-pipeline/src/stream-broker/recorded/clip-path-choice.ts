/**
 * clip-path-choice — WHICH clip path a consumer gets, decided in one place
 * and said out loud (D597).
 *
 * Two paths exist behind `playClip` after stage 2:
 *
 * - the FILE path (D575): one bounded by-handle fetch of the whole clip,
 *   `stbl` indexed, pulled by the recorded feeder — free seeking, either twin;
 * - the STREAM path (D597): the provider's fMP4 stream, pushed forward-only
 *   through `clip-stream-feeder.ts` — first frame at the first fragment, the
 *   sub twin only.
 *
 * The rule: **the stream serves every ask, and the file path is what a broker
 * that cannot dial one falls back to.** The stream's whole point is the first
 * frame (183–284 ms against 823–3643 ms for the file, and the file grows with
 * the clip while the stream stays flat).
 *
 * `high` used to be carved out to the file path, because stage 1 served the
 * sub twin only and handing it a `high` would be the silent 33× substitution
 * D576 forbids. D599 removed the carve-out rather than the honesty: the dial
 * now resolves the twin through the provider's one `chooseClipTwin`, and its
 * answer STATES which twin it carries (`served`). Two transports behind one
 * pointer, differing only in which profile they accept, is the kind of split
 * that makes a bug appear on one quality and not the other.
 *
 * Absence is decided here too, not by a fallthrough: a session with neither
 * accessor wired has no clip playback. Each answer carries its reason so the
 * broker's log line says which path served, and why.
 */
import type { CamProfile } from '@camstack/types'
import type { FeederStateTransition } from './recorded-feeder.js'
import type { ClipPlaybackHandle, TimelineSessionClipFeeder } from './timeline-session.js'

export interface ClipPathInput {
  /**
   * The ask, kept for the log line and NOT read by the decision since D599:
   * the stream serves every profile. A branch here would be this consumer
   * second-guessing which twin the provider can produce, which is the
   * provider's own question (`chooseClipTwin`).
   */
  readonly profile: CamProfile | null
  /** `videoclips.dialClipStream` is wired on this broker. */
  readonly streamDialWired: boolean
  /** `videoclips.readClipBytes` is wired on this broker. */
  readonly fileReadWired: boolean
}

export type ClipPathChoice =
  | { readonly path: 'stream'; readonly reason: 'stream-serves-every-profile' }
  | { readonly path: 'file'; readonly reason: 'no-stream-dial-wired' }
  | { readonly path: 'none'; readonly reason: 'nothing-wired' }

export function chooseClipPath(input: ClipPathInput): ClipPathChoice {
  if (input.streamDialWired) return { path: 'stream', reason: 'stream-serves-every-profile' }
  if (input.fileReadWired) return { path: 'file', reason: 'no-stream-dial-wired' }
  return { path: 'none', reason: 'nothing-wired' }
}

export interface RefusedClipFeederDeps {
  readonly handle: ClipPlaybackHandle
  readonly reason: Extract<ClipPathChoice, { path: 'none' }>['reason']
  onState(transition: FeederStateTransition): void
  onLog?(msg: string, data: Record<string, unknown>): void
}

/**
 * The feeder a `none` choice gets: every verb is a named refusal and the
 * first seek reports `error`, so a clip nothing can serve is never a frozen
 * frame with no line behind it (D391).
 */
export function createRefusedClipFeeder(deps: RefusedClipFeederDeps): TimelineSessionClipFeeder {
  const data = { deviceId: deps.handle.deviceId, clipId: deps.handle.clipId, reason: deps.reason }
  let announced = false
  const refuse = (verb: string): void => {
    deps.onLog?.('clip playback: refused — no path can serve this clip', { ...data, verb })
    if (announced) return
    announced = true
    deps.onState({ from: null, to: 'error', reason: `refused:${deps.reason}`, seekToken: 0 })
  }
  return {
    seek: async () => refuse('seek'),
    // A rate this feeder "accepts" and never applies is the same silence as a
    // dropped seek wearing a different hat (D391) — and it is the operator's
    // own report in miniature. It refuses like every other driving verb.
    setRate: () => refuse('setRate'),
    stepFrame: () => refuse('stepFrame'),
    beginScrub: () => refuse('beginScrub'),
    // `scrubTo` and `scrubAck` stay SILENT, deliberately: they ride every
    // pointer move and every rendered frame, and `beginScrub` has already
    // refused the gesture they belong to, by name, once. A line per move is
    // the storm that buries the line that matters. This is the exception, and
    // it is written down rather than left to look like an oversight.
    scrubTo: () => {},
    scrubAck: () => {},
    durationMs: () => Promise.resolve(null),
    dispose: () => {},
  }
}
