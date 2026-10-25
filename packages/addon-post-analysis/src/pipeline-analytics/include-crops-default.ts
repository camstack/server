/**
 * Whether a gallery read inlines its crops — ONE place, for every gallery.
 *
 * ## Why the default is `false`
 *
 * It used to be `true`, on both galleries, which made the DEFAULT behaviour of
 * these endpoints the one that cannot complete. Measured on the live hub
 * 2026-08-25 at 500 rows:
 *
 *   faceGallery.listRecentFaces  inline: 60 457 ms → UDS TIMEOUT
 *                                opt-out:    701 ms,  297 KB
 *   plateGallery.listPlates      inline:  826 565 B
 *                                opt-out:   31 173 B   (-96%)
 *
 * The system stayed up only because all three known callers remembered to opt
 * out — the admin UI, the viewer through
 * `FACE_ID_RESOLUTION_QUERY`. That is not a property of the design, it is a
 * property of three people having been careful. The next caller that forgets
 * gets a sixty-second timeout, in production, on a page that polls.
 *
 * Inverting costs nothing that exists: every caller today passes `false`
 * explicitly, so this is a no-op for all of them. What changes is that the
 * expensive shape must now be ASKED for by name, which is the correct place to
 * put the burden — on the one caller that wants it, not on everyone who does
 * not know they should decline.
 *
 * Crops are still reachable: the row carries `cropUrl`, which the browser
 * fetches off the data plane in parallel instead of through one serialized
 * JSON blob on a single-threaded channel.
 */
export interface IncludeCropsInput {
  readonly includeCrops?: boolean
}

export function resolveIncludeCrops(input: IncludeCropsInput | undefined): boolean {
  return input?.includeCrops === true
}
