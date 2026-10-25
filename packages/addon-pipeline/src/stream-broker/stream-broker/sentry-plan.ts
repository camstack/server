/**
 * WHETHER a lazy source gets a sentry, and at what geometry.
 *
 * The sentry fills the gap between "someone asked for this camera" and "the
 * camera is awake" with the camera's own last picture. On this hub that gap is
 * measured at 2.2-12.4 s, and it is not merely ugly: Amazon requires an SDP
 * answer within SIX SECONDS, so a cold battery camera cannot answer an Echo in
 * time at all. The fill is what makes the broker servable before the camera is.
 *
 * Two preconditions, and the second is the one that has already cost this repo
 * a regression:
 *
 *  - **A lazy source.** Not "a battery camera": the precondition is that there
 *    is a WAIT between demand and media, which is what `lazy:rfc4571:` means.
 *    It catches the cloud-relayed robot camera too, and it excludes a battery
 *    camera whose stream is already up.
 *  - **A KNOWN geometry.** A sentry encoded at a different size from the
 *    real stream injects a different SPS, and `stream-broker.ts` records what
 *    that does: "Chrome's decoder freezes on the last placeholder frame until
 *    the user manually restarts". A camera nobody has probed therefore gets NO
 *    sentry and a log line saying why — refusing is cheap, and the
 *    alternative is the exact failure the placeholder was cut back for.
 *
 * `null` is a refusal with a reason attached, because a branch that produces
 * nothing has to be able to explain itself.
 */

export type SentryRefusal = 'not-lazy' | 'unknown-geometry' | 'unknown-codec'

export interface SentryPlanInput {
  /** The source url, as published. A lazy one carries the sentinel. */
  readonly sourceUrl: string | undefined
  /** The camera's probed geometry — absent when nobody has read it. */
  readonly width: number | undefined
  readonly height: number | undefined
  /** The codec the real stream will arrive in. */
  readonly codec: string | undefined
}

export interface SentryPlan {
  readonly width: number
  readonly height: number
  readonly codec: 'h264' | 'h265'
}

export const LAZY_URL_SENTINEL = 'lazy:rfc4571:'

export function planPrestream(
  input: SentryPlanInput,
): { readonly plan: SentryPlan } | { readonly refusal: SentryRefusal } {
  if (input.sourceUrl === undefined || !input.sourceUrl.startsWith(LAZY_URL_SENTINEL)) {
    return { refusal: 'not-lazy' }
  }
  if (
    input.width === undefined ||
    input.height === undefined ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return { refusal: 'unknown-geometry' }
  }
  const codec = normaliseCodec(input.codec)
  if (codec === null) return { refusal: 'unknown-codec' }
  return { plan: { width: input.width, height: input.height, codec } }
}

/**
 * `null` for a codec nobody has read. NOT a default of h264: a sentry in the
 * wrong codec is a stream the consumer cannot decode at all, which is worse
 * than the black screen it replaces.
 */
function normaliseCodec(codec: string | undefined): 'h264' | 'h265' | null {
  if (codec === undefined) return null
  const c = codec.toLowerCase().replace(/[.\s-]/g, '')
  if (c === 'h264' || c === 'avc' || c === 'avc1') return 'h264'
  if (c === 'h265' || c === 'hevc' || c === 'hvc1' || c === 'hev1') return 'h265'
  return null
}
