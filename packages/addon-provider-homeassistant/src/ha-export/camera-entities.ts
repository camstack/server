/**
 * The live `camera` entities — one per STREAM of the camera.
 *
 * ── What was wrong, measured on the operator's Home Assistant ────────────
 *
 * This module used to mint six components per camera (three profiles ×
 * muted/unmuted), each carrying a broker RTSP url on a `state_topic`,
 * behind two url gates: a refusal for a credential in the authority and a
 * refusal for a loopback host. On 2026-08-14 the live registry was read:
 * `platform: camstack` held **165 entities and exactly two `camera` ones**
 * — one per exported camera, `unique_id` `camstack_<deviceId>_camera`.
 * None of the twelve announced stream components existed.
 *
 * They never could. `custom_components/camstack/camera.py` builds its
 * cameras from the export MEMBERSHIP, not from `cmps`: a still comes from
 * `snapshot.getSnapshot` and live video from `webrtcSession.handleOffer`,
 * which is native WebRTC and has no use for an RTSP address. The
 * component's platform probe answers `camera` — truthfully, it builds the
 * platform — and the hub read that as "it will build MY camera
 * components". Twelve components, two entities, no warning on either
 * side.
 *
 * ── What this module is now ──────────────────────────────────────────────
 *
 * One component per entry of `webrtcSession.listStreams`, carrying the
 * `target` verbatim so the component hands it back to `handleOffer`. No
 * url crosses, which is why the two gates are gone rather than kept "just
 * in case": there is no address here to leak a password or to point at
 * 127.0.0.1, and a gate guarding a value that no longer exists is the
 * leftover that reads as verification.
 *
 * ── The adaptive stream is announced by NOBODY, on purpose ───────────────
 *
 * The component's membership entity IS the adaptive stream: it negotiates
 * no target, it is the device's primary camera (`_attr_name = None`), and
 * it carries `camstack_<deviceId>_camera` — the component builds that one
 * itself, from the export membership, mirroring `deviceKeyFor`'s numeric
 * rule. Announcing a component for it would claim the same
 * `unique_id` — Home Assistant keys its registry on
 * `(platform, integration, unique_id)` — and one of the two would lose the
 * race and be dropped with a "does not generate unique IDs" error. So the
 * operator's existing `camera.camera_front_door` is left exactly where
 * it is and gains SIBLINGS: one per profile, one per substream, which are
 * the streams membership cannot express.
 *
 * ── Fan-out ──────────────────────────────────────────────────────────────
 *
 * Every remaining stream is announced. What arrives ENABLED is the
 * assigned profiles — the pictures an operator picks between on a
 * dashboard. The raw `cam-stream` sources (the camera's own main/sub
 * substreams) are registered-and-off: they are the same pictures the
 * profiles already serve, one layer below the slot the rest of camstack
 * dials, and an operator who wants one switches it on per camera.
 */

import { toSlug } from './topics.js'
import type { CatalogStreamChoice, HaPlatform } from './types.js'
import type { WebrtcStreamTarget } from '@camstack/types'

/** Profile slots, in the order an operator reads them. */
export const CAMERA_PROFILE_ORDER: readonly string[] = ['high', 'mid', 'low']

/** One `camera` entity: a stream of the camera, and the target it dials. */
export interface CameraStreamEntity {
  /** Entity id / topic segment, e.g. `stream_high`. */
  readonly entity: string
  readonly platform: HaPlatform
  readonly label: string
  readonly enabledByDefault: boolean
  readonly target: WebrtcStreamTarget
}

/** `high` → 0. An unknown profile sorts after the known ones, stably. */
function profileRank(profile: string): number {
  const index = CAMERA_PROFILE_ORDER.indexOf(profile)
  return index === -1 ? CAMERA_PROFILE_ORDER.length : index
}

/**
 * Reading order: adaptive, then the profile slots high → mid → low, then
 * whatever raw sources the camera reports, in the hub's own order.
 *
 * Rank only. The one stream that does NOT become a component is the
 * adaptive one, and it is filtered by {@link isAnnounced} rather than
 * here, because it is not a drop: it reaches Home Assistant on the
 * membership entity. Every other slot the hub reports becomes an entity —
 * "include all the streams of a camera" is the request this module exists
 * to answer, and a slot silently dropped is a loss the operator cannot see
 * from Home Assistant.
 */
function streamRank(target: WebrtcStreamTarget): number {
  switch (target.kind) {
    case 'adaptive':
      return 0
    case 'profile':
      return 1 + profileRank(target.profile)
    case 'cam-stream':
      return 1 + CAMERA_PROFILE_ORDER.length
  }
}

/**
 * The adaptive stream is the component's own entity and gets no component.
 *
 * The one filter in this file, and the reason it is not the "drop a slot"
 * kind: the stream still reaches Home Assistant, on the entity that has
 * always carried it. See the identity note above.
 */
function isAnnounced(target: WebrtcStreamTarget): boolean {
  return target.kind !== 'adaptive'
}

/**
 * The entity id of one stream.
 *
 * Derived from the TARGET rather than from `choice.id`, so the ids stay
 * `stream_high` / `stream_mid` / `stream_low` — what this file already
 * announced — instead of following the picker's `profile:high` spelling.
 * An entity id is identity; the picker's id is a React key.
 */
function entityIdFor(target: WebrtcStreamTarget): string {
  switch (target.kind) {
    case 'adaptive':
      /* c8 ignore next -- filtered by isAnnounced before it can be reached */
      return 'stream_adaptive'
    case 'profile':
      return `stream_${toSlug(target.profile)}`
    case 'cam-stream':
      return `stream_${toSlug(target.camStreamId)}`
  }
}

/**
 * Enabled by default: the assigned profiles.
 *
 * A raw `cam-stream` is the source a profile slot already points at. It
 * is announced so an operator who wants the camera's own substream can
 * have it, and it is off so that a camera does not arrive with six
 * pictures of the same doorway switched on.
 */
function enabledByDefaultFor(target: WebrtcStreamTarget): boolean {
  return target.kind !== 'cam-stream'
}

/**
 * The label an operator reads on a card.
 *
 * The hub's own label plus the vertical resolution, because that is the
 * one thing that distinguishes three pictures of the same doorway —
 * "Stream high (2160p)" answers "which of these do I put on the wall
 * tablet" and "Stream high" does not. The resolution is only in the label
 * (never in the id), so a re-encoded profile renames an entity and never
 * orphans one.
 */
function labelFor(choice: CatalogStreamChoice): string {
  const base = `Stream ${choice.label.toLowerCase()}`
  return choice.height === undefined ? base : `${base} (${choice.height}p)`
}

/**
 * Stream list → the `camera` entities the catalog builds.
 *
 * Pure, and value-free: a `camera` entity has no state on the push plane
 * at all. It exists because the hub lists the stream, and everything the
 * component needs to show it travels in `stream_target`.
 */
export function cameraStreamEntities(
  choices: readonly CatalogStreamChoice[],
): readonly CameraStreamEntity[] {
  return [...choices]
    .filter((choice) => isAnnounced(choice.target))
    .sort((a, b) => streamRank(a.target) - streamRank(b.target))
    .map((choice) => ({
      entity: entityIdFor(choice.target),
      platform: 'camera' as HaPlatform,
      label: labelFor(choice),
      enabledByDefault: enabledByDefaultFor(choice.target),
      target: choice.target,
    }))
}
