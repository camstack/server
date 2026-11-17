import type { CamProfile, ClipWake } from '@camstack/types'
import type { ClipStreamAudioAsk } from './clip-stream-feeder.js'

/**
 * The broker's two clip calls into `videoclips`, as the cap input they send.
 *
 * ONE place composes them so the operator's wake cannot be dropped on one
 * path and kept on the other. `wake` is set by exactly one producer: the
 * `playClip` a viewer sends (`timeline-session.ts`), the same demand
 * wake-on-play treats pressing play as on the live path (D173). A sleeping
 * standalone battery camera refuses a read without it (`sleeping`), and the
 * provider — not this module — decides whether to spend it.
 */

/** What the broker knows when it reads a clip FILE. */
export interface ClipReadArgs {
  readonly deviceId: number
  readonly clipId: string
  /** The `addonId` holding the bytes — named, never resolved in-process. */
  readonly provider: string
  /** `null` ⇒ the provider's own default twin; never invented here. */
  readonly profile: CamProfile | null
  /** Present only on the operator path (a viewer's `playClip`). */
  readonly wake?: ClipWake
}

/** What the broker knows when it dials a clip STREAM (D597). */
export interface ClipDialArgs extends ClipReadArgs {
  /** The session's negotiated audio codec (D600); `none` is a real ask. */
  readonly audio: ClipStreamAudioAsk
}

/**
 * `videoclips.readClipBytes` input, as the broker sends it. A type alias, not
 * an interface: the generated cap client takes `{ [x: string]: unknown } & …`,
 * and only an alias is assignable to an index signature.
 */
export type ClipReadCapInput = {
  readonly deviceId: number
  readonly clipId: string
  readonly provider: string
  readonly profile?: CamProfile
  readonly wake?: ClipWake
}

/** `videoclips.dialClipStream` input, as the broker sends it. */
export type ClipDialCapInput = ClipReadCapInput & {
  readonly audio: ClipStreamAudioAsk
}

export function clipReadCapInput(args: ClipReadArgs): ClipReadCapInput {
  return {
    deviceId: args.deviceId,
    clipId: args.clipId,
    provider: args.provider,
    ...(args.profile !== null ? { profile: args.profile } : {}),
    ...(args.wake !== undefined ? { wake: args.wake } : {}),
  }
}

export function clipDialCapInput(args: ClipDialArgs): ClipDialCapInput {
  return { ...clipReadCapInput(args), audio: args.audio }
}
