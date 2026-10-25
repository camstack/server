/**
 * Types and constants the pipeline-analytics boot builders share.
 *
 * Moved out of `pipeline-analytics/index.ts` with the store builder
 * (Plan B, boot extraction) so the builders can name them without importing
 * the addon module.
 */

import type { AddonContext, MotionEventDraft } from '@camstack/types'
import type { NcArtifactPublication } from '../../notification-center/artifact-plane.js'
import { AudioMetricsProvider } from '../audio-metrics-provider.js'
import { EventStore } from '../store/event-store.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import { PlateStore } from '../store/plate-store.js'
import { TrackStore } from '../store/track-store.js'
import { VehicleStore } from '../store/vehicle-store.js'
import { ZoneAnalyticsProvider } from '../zone-analytics-provider.js'

/** The addon's tRPC api surface after the boot-time null guard. */
export type AnalyticsApi = AddonContext['api']

/** Non-null store bundle returned by the S7 store builder — lets the rest of
 *  boot consume the stores without re-narrowing the class's nullable fields. */
export interface AnalyticsStores {
  readonly trackStore: TrackStore
  readonly mediaStore: MediaStore
  readonly eventStore: EventStore
  readonly identityStore: IdentityStore
  readonly faceStore: FaceStore
  readonly plateStore: PlateStore
  readonly vehicleStore: VehicleStore
}

/** D683 review H2: bounded memo size for the sampled alias-resolve-failure
 *  WARN shared by every `resolvingTrackIds`/`resolveMediaOwnerId` call site
 *  (same shape as the NC dispatcher's `NC_ANNOTATED_FALLBACK_MEMO_MAX`). */
export const ALIAS_RESOLVE_FAILURE_MEMO_MAX = 2_000

/**
 * The per-kind fields a motion episode row is opened with — the tracker's
 * opaque `regionData`, read on the episode's FIRST edge only (D475). Carries
 * `triggeredBy` for an onboard episode (D672), so the first trigger is what
 * the row records.
 */
export type MotionEpisodeRowData = Pick<
  MotionEventDraft,
  'regionCount' | 'regions' | 'frameWidth' | 'frameHeight' | 'triggeredBy'
>

/** Max |keyFrame − measured| skew (ms) accepted for a DURABLE keyFrame-derived
 *  crop when the track's position trail carries NO motion evidence about the
 *  two instants. With evidence the motion guard decides instead — time was
 *  never the quantity that separated a right crop from a wrong one. */
export const KEYFRAME_CROP_MAX_SKEW_MS = 1500

/**
 * Subject-box IoU across the two instants at or above which a keyFrame-derived
 * crop is accepted whatever the skew.
 *
 * Chosen from the 2026-08-30 debug-marked tracks, where each crop's verdict
 * came from LOOKING at the stored image (`docs/design/
 * 2026-08-30-debug-marked-tracks-media-triage.md`):
 *
 *   `e9c024bb`  windshield, wrong   skew 1179 ms   IoU 0.063
 *   `4126f977`  gravel, wrong       skew  531 ms   IoU 0.318
 *   `7613c0fa`  plate framed, RIGHT skew 2579 ms   IoU 1.000
 *
 * Note the ordering: the only correct crop of the three has the LARGEST skew.
 * The healthy population sits far above the wrong pair too — subject IoU across
 * a 1500 ms lag is 0.83–1.00 on the eight debug tracks whose tiles frame their
 * subject. 0.5 is the midpoint of the empirical gap (0.318 → 1.000) and stays
 * well under that 0.83 floor. A refusal is not a lost tile: the close path
 * falls through to the retained detection-raster crop, which is right-moment
 * pixels by construction, so a false refusal costs resolution, not the image.
 */
export const KEYFRAME_CROP_MIN_SUBJECT_IOU = 0.5

/** How far a position sample may sit from an instant and still be evidence
 *  about it. The trail is one sample per emitted frame and is downsampled only
 *  on long tracks (≈280–385 ms spacing at 60–95 s of life), so a full second
 *  covers a healthy trail many times over; past it the honest answer is "no
 *  evidence" and the temporal bound takes over. */
export const KEYFRAME_CROP_MAX_SAMPLE_GAP_MS = 1000

/** Padding applied to the parent bbox for the `cropJpeg` retry fallback when a
 *  scheduled detail call's frameHandle lease is already gone. */
export const DETAIL_FALLBACK_CROP_PADDING = 0.15

/** The two cap providers built at boot and registered from onInitialize. */
export interface AnalyticsCapProviders {
  readonly zoneAnalytics: ZoneAnalyticsProvider
  readonly audioMetrics: AudioMetricsProvider
}

export const PIPELINE_ANALYTICS_ADDON_ID = 'pipeline-analytics'

/** What a publish answers on a node whose artifact plane never came up: no
 *  link, no index row — and, exactly as before, bytes-only delivery. */
export const NO_PUBLICATION: NcArtifactPublication = { url: null, artifactId: null }

/**
 * How many tracks ONE timelapse window may read.
 *
 * Explicit because `queryHistorical` defaults to 50, and this one array feeds
 * BOTH the dense-range plan and the notification's per-class counts. At the
 * default, a busy ten-hour night planned its fast-cadence stretches from the
 * newest fifty tracks and would now also report "50 persone" for a night that
 * held four hundred — a count that under-reports silently is worse than no
 * count. Two thousand is far above any real night and still a bounded read.
 */
export const TIMELAPSE_TRACK_QUERY_LIMIT = 2_000

/**
 * How many object-event rows ONE timelapse window may read.
 *
 * Higher than the track limit because these are per-FRAME rows, not per-subject:
 * one track routinely writes a handful (`entered`, some `moving`, `left`), and
 * the merge in `detection-intervals.ts` folds them back to one subject. Ten
 * thousand covers every night this deployment has produced and still bounds the
 * read; the store returns the NEWEST rows, so an overflow loses the start of the
 * window rather than a random slice of it.
 */
export const TIMELAPSE_EVENT_QUERY_LIMIT = 10_000

/** The `mutate` / `query` callable on a generated cap procedure. */
export type CapCall = (input: unknown) => Promise<unknown>

/**
 * A tRPC-shaped router or procedure reached by DYNAMIC name off `ctx.api`.
 *
 * A rule names its cap and method as strings, so the generated client cannot be
 * indexed statically. The walk down `api → router → procedure → mutate|query`
 * is therefore guarded hop by hop rather than asserted: every hop that is not
 * what it must be raises the named error the rule author needs to see.
 *
 * Forked-addon `ctx.api` namespaces are tRPC v11 Proxies over a noop function
 * (`typeof === 'function'`). Treating only plain objects as routers made every
 * sequence step fail with `no router for capability "alarm-panel"` while the
 * same method answered fine over HTTP — the panel never left `armed_*`, so
 * HomeKit stayed quiet.
 */
export function isCapNode(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export function isCapCall(value: unknown): value is CapCall {
  return typeof value === 'function'
}
