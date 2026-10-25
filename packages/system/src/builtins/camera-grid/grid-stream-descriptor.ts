/**
 * What a grid camera tells the broker it offers: one stream per profile.
 *
 * ## Why a `stream-catalog` descriptor and not `publishCameraStream`
 *
 * The broker PULLS this catalog per camera and reconciles its registry against
 * it. Anything the broker holds that the catalog does not name is swept — which
 * is the sweep `brokerOwned: true` exists to opt OUT of, for streams no
 * provider can ever declare (a `derived:*`, an `egress:*`). A grid is not one
 * of those: this addon owns the device, answers `getCatalog` for it, and names
 * its streams on every pull. Being PRESENT in the catalog is what keeps them,
 * and `brokerOwned` is not on the cap wire at all — deliberately, so a cap
 * caller cannot make its own publication un-sweepable.
 *
 * The corollary is the rule this addon has to keep: `getCatalog` must name
 * every OFFERED stream on EVERY pull, including while the composition is idle.
 * It describes what the grid offers, not what is running.
 *
 * ## One descriptor per OFFERED profile
 *
 * A grid's `low` is composed of its sources' `low`, onto the canvas their `low`
 * implies — so the three are each 1:1 with what they are made of, and a
 * viewer's adaptive picks a rung without knowing a grid is a grid.
 *
 * A profile one source cannot serve is not named here at all: composing a hole
 * is worse than not offering, because the operator files the hole as a broken
 * camera.
 */
import type { CamProfile, CamStreamDescriptor } from '@camstack/types'
import { gridCamStreamId } from './grid-profiles.js'
import { GRID_WIRE_STREAM_KIND } from './grid-wire-format.js'

export interface GridStreamDescriptorInput {
  /** Which composition this is. Also the `profileHint` — see below. */
  readonly profile: CamProfile
  /** The DERIVED canvas of that profile, never an authored number. */
  readonly width: number
  readonly height: number
  readonly fps: number
  /** The on-demand endpoint the broker dials. Dialling it IS the demand. */
  readonly url: string
}

/**
 * `profileHint` is load-bearing, not decoration.
 *
 * A device publishing a SINGLE stream with no hint is ranked by pixel count,
 * and a single stream ranks into `mid` — the slot `recordings` does not select
 * on its own (`high|mid` picks high), that `recordingsLow` ignores, and that
 * scrub never reads. The Dreame robot's one 720p relay landed exactly there and
 * its footage was written nowhere anything looked.
 *
 * With several compositions published the hint does a second job: it says which
 * slot each one is FOR. Ranked by pixels a grid's `mid` would take the `high`
 * slot on any grid whose `high` was not offered.
 */
export function gridStreamDescriptor(input: GridStreamDescriptorInput): CamStreamDescriptor {
  return {
    camStreamId: gridCamStreamId(input.profile),
    // `pull-flv`, because that is what this endpoint SERVES and because
    // `pull-http` means MJPEG in this broker: it answers with
    // `HTTP_MJPEG_H264_OUTPUT_ARGS`, so a grid declaring it had its already
    // encoded H.264 re-encoded by libx264 for nothing — on the way into an
    // ffmpeg TS-demux path that crashes. `pull-flv` is documented as always
    // ingested through the source reader with `-c copy`: no second encode.
    kind: GRID_WIRE_STREAM_KIND,
    url: input.url,
    codec: 'h264',
    resolution: { width: input.width, height: input.height },
    fps: input.fps,
    label: `Grid composition (${input.profile})`,
    profileHint: input.profile,
    autoEligible: true,
  }
}
