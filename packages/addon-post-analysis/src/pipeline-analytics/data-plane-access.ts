/**
 * data-plane-access — the hub-side auth level of every pipeline-analytics data
 * plane, in ONE table.
 *
 * ## Why this is a table and not six inline literals
 *
 * The levels drifted from the cap surface serving the same bytes, and nothing
 * noticed for as long as everyone looking at the UI was an admin.
 * `event-media` was registered `admin` while `pipelineAnalytics.getTrackMedia`
 * and `getEventMedia` — the SAME stored blob, base64 over tRPC — are declared
 * `access: 'view'` in the generated method-access map. Verified against the
 * live hub on 2026-08-08: `getTrackMedia` returns the thumbnail's bytes for a
 * caller the data plane would have refused.
 *
 * So the `admin` gate on `event-media` was not protecting the media. It was
 * costing every NON-admin operator and viewer session its thumbnails — an
 * `<img>` that 403s renders as a broken tile, and the tile is all a list is.
 *
 * ## The rule
 *
 * **A plane serving ONE item the caller already had to be told about is
 * `authenticated`. A plane that walks off with a CORPUS is `admin`.**
 *
 * An event-media URL is unguessable and per-item: to ask for it you must
 * already hold a `trackId` / `bestEventId`, which comes from a track query
 * that is itself `view`. An export plane is the opposite — one request, every
 * stored frame behind a selection — so it stays `admin` regardless of who can
 * read a single crop.
 *
 * `public` here does NOT mean unauthenticated: it means the hub proxies
 * without checking, because the plane authenticates the request ITSELF. Both
 * notification-center planes do exactly that with a single-use action/artifact
 * token (D47), and they must stay `public` — a notification button is opened
 * from a phone with no hub session at all.
 *
 * ## What this does NOT change
 *
 * Per-DEVICE authorization. Neither this plane nor the `view` cap methods
 * filter by a user's `allowedDevices` — that model is enforced only on the
 * live-event stream today. Making event-media `authenticated` therefore
 * exposes nothing that `getTrackMedia` did not already expose to the same
 * caller; it does not close the per-device gap either. Closing it needs the
 * hub gate to carry a principal's device scope into the plane, which is a
 * backend change — see `docs/design/2026-08-08-events-embed.md`.
 *
 * Face and plate gallery media are NOT in this table and are unaffected.
 */
import type { RouteAccess } from '@camstack/types'
import { NC_ARTIFACT_READ_PREFIX } from '../notification-center/artifact-index.js'

/**
 * Prefix literals for the export planes, mirrored here so the policy reads as
 * a table without importing three handler modules into the addon's boot path.
 * `data-plane-access.spec.ts` asserts they still match the constants their
 * handlers register with — a mirror nothing checks is a lie waiting to happen.
 */
/** The artefact read route's prefix, imported rather than mirrored: it is
 *  ALSO the prefix `artifactDownloadPath` writes into every index row, and two
 *  copies of that string is a 404 nobody would find. */
export const NC_ARTIFACT_READ_PREFIX_REF = NC_ARTIFACT_READ_PREFIX
export const TRAINING_EXPORT_PREFIX_REF = 'training-export'
export const RETRAIN_EXPORT_PREFIX_REF = 'retrain-export'
export const RETRAIN_FRAME_PREFIX_REF = 'retrain-frame'
const DEBUG_EXPORT_PREFIX_REF = 'debug-export'
export const TAPE_EXPORT_PREFIX_REF = 'tape-export'

/**
 * Every data plane this addon serves, and the level the HUB enforces before it
 * proxies. Exhaustive by test: a new plane that forgets to appear here fails
 * `data-plane-access.spec.ts`.
 */
export const PIPELINE_ANALYTICS_PLANE_ACCESS = {
  /** One stored crop/thumbnail by an unguessable id the caller already holds. */
  'event-media': 'authenticated',
  /** Self-authenticating single-use action token (D47). */
  'nc-action': 'public',
  /** Self-authenticating single-use artifact token (D47). */
  'nc-artifact': 'public',
  /**
   * The VIEWER's read of the same bytes (task #36). One indexed artefact by an
   * unguessable id the caller was handed by `nc.listArtifacts` — the rule above,
   * applied unchanged. It is deliberately NOT the `public` signed plane: the
   * viewer holds a session, and pre-minting a 24 h signed link for every
   * artefact a user might scroll to is a link-leak surface for no gain.
   */
  [NC_ARTIFACT_READ_PREFIX_REF]: 'authenticated',
  /** Every frame behind a marked selection — a corpus, not an item. */
  [TRAINING_EXPORT_PREFIX_REF]: 'admin',
  [RETRAIN_EXPORT_PREFIX_REF]: 'admin',
  /**
   * One copied retrain frame by its id. `admin`, not `authenticated`: the item
   * is single, but the cap that served the same bytes (`getRetrainFrameImage`)
   * is `auth: 'admin'` and the surface is admin curation — widening the bytes
   * beyond the method they replace would be a policy change nobody asked for.
   */
  [RETRAIN_FRAME_PREFIX_REF]: 'admin',
  /** Diagnostic bundle: logs, config and frames. */
  [DEBUG_EXPORT_PREFIX_REF]: 'admin',
  /** A promoted tracking tape and its ground truth (D681) — a corpus, not an item. */
  [TAPE_EXPORT_PREFIX_REF]: 'admin',
} as const satisfies Record<string, RouteAccess>

export type PipelineAnalyticsPlanePrefix = keyof typeof PIPELINE_ANALYTICS_PLANE_ACCESS

/** The declared level for a plane prefix. Typed, so a prefix with no declared
 *  policy is a compile error rather than a silent default. */
export function planeAccess(prefix: PipelineAnalyticsPlanePrefix): RouteAccess {
  return PIPELINE_ANALYTICS_PLANE_ACCESS[prefix]
}
