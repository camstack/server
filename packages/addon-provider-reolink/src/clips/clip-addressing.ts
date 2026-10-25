/**
 * How a Reolink camera's catalog is ADDRESSED — the one place the uid rule
 * lives.
 *
 * The rule is topology-dependent and was measured, not assumed (2026-09-20,
 * read-only, both topologies):
 *
 * - **Standalone** — the uid is IGNORED. `getDayRecords` answered 592 the same
 *   19 days with the right uid, with a wrong uid and with none at all, and
 *   nodelink-js resolves a standalone's own uid over cmd 114 (7 ms, cached)
 *   for the commands that really carry one. Nothing persists a uid for a
 *   standalone in `deviceMeta`, and nothing needs to: 107 has none today and
 *   listed 209 clips through this provider.
 * - **Hub child** — the uid is what SELECTS the camera. Channel 1 asked with
 *   channel 0's uid answers channel 0's days; the hub's OWN uid addresses no
 *   catalog at all (empty month over 24 months, zero files, zero rows). A
 *   child with no persisted uid — 3825 today — cannot be addressed, and that
 *   is not the same as having no clips.
 *
 * An unconditional gate therefore refuses a camera that would answer. It did:
 * 592's only source read `unreachable / uid-missing` on the first live run of
 * the clips surface, an hour after the same provider had listed its day. That
 * is the "not-yet-known must never look like not-installed" defect (D315) in
 * vendor clothing — the camera did not decline, we did.
 */

declare const CameraUidBrand: unique symbol

/**
 * A camera uid that came from {@link resolveCameraUid} — the only thing that
 * has seen BOTH places one can live.
 *
 * Branded on purpose. The uid is held twice: `deviceMeta.metadata.uid`, which
 * is written at adoption and refreshed from the firmware, and `config.uid`,
 * which is a COPY taken at adoption and never written again. A camera adopted
 * before that copy existed keeps an empty one for ever — 3825 did, and
 * answered `uid-missing` on 2026-09-21 while holding `9527000MSU931AUT` in its
 * metadata, because the reader consulted the frozen copy.
 *
 * A rule saying "read the metadata" is a rule nothing checks. A brand makes
 * the same claim structurally: a reader that reaches for one copy does not
 * produce a subtly wrong answer, it fails to compile. ([D224])
 */
export type CameraUid = string & { readonly [CameraUidBrand]: true }

/** Where the uid may be read from. Both, always — that is the whole point. */
export interface CameraUidSources {
  /** The authority: written at adoption, refreshed from the firmware. */
  readonly metadataUid: string | undefined
  /** The adoption snapshot. Right for most cameras, empty for ever on some. */
  readonly configUid: string | undefined
}

/**
 * The camera's uid, from the fresh copy where there is one.
 *
 * An empty or whitespace-only value is ABSENT, never a uid: it is how a
 * cleared settings field arrives, and passed on it addresses no camera at all
 * while making the refusal name the wrong cause.
 */
export function resolveCameraUid(sources: CameraUidSources): CameraUid | undefined {
  return usable(sources.metadataUid) ?? usable(sources.configUid)
}

function usable(value: string | undefined): CameraUid | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // The one mint. A documented type boundary, which is what the brand is for.
  return trimmed.length === 0 ? undefined : (trimmed as CameraUid)
}

/**
 * The two facts the uid rule is decided from. Deliberately narrower than
 * `ClipDeviceRef`: the rule must not be able to consult anything else.
 */
export interface ClipAddressingSubject {
  /** Served by a parent Home Hub — the topology where the uid selects. */
  readonly isHubChild: boolean
  /** The CAMERA's own uid — {@link resolveCameraUid}'s answer, never a raw read. */
  readonly uid: CameraUid | undefined
}

/** Does addressing this camera's catalog REQUIRE a persisted uid? */
export function uidIsRequired(subject: ClipAddressingSubject): boolean {
  return subject.isHubChild
}

/**
 * Is this camera unaddressable for want of a uid? The gate every catalog,
 * still and byte read runs — and the only one that may answer `uid-missing`.
 */
export function uidIsMissing(subject: ClipAddressingSubject): boolean {
  return uidIsRequired(subject) && subject.uid === undefined
}

/** The one wording for the refusal, so two surfaces cannot disagree about it. */
export const UID_MISSING_REASON =
  'uid-missing: the hub selects a child by uid, and this camera has none persisted.'
