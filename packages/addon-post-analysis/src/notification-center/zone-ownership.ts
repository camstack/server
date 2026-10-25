/**
 * Per-camera scoping of a zone id list — the pure half.
 *
 * A `zones` condition is a FLAT list of zone ids, and a rule is routinely
 * multi-camera ("notify me for the driveway and the gate"). Evaluated flatly,
 * picking a zone on camera A silently muted camera B: B's detections can never
 * visit a polygon drawn on A, so every B subject failed `zones` forever, and
 * nothing anywhere said so. What the operator meant when they picked that zone
 * is "…on THAT camera" — the other cameras keep matching whole-frame.
 *
 * Zone ids are unique per camera (the ZoneEngine stamps a per-device
 * catalogue), so the rule needs no schema change: WHICH camera a zone belongs
 * to is already recoverable from the zone catalogue. This module is the one
 * place that turns "the rule's ids" into "the ids that apply to THIS camera".
 *
 * ── The unknown case, and why it does NOT fail toward whole-frame (D49) ─────
 *
 * Ownership comes from a mirror ({@link NcZoneOwnerLookup}), and a mirror can
 * be cold, stale, or fed by a read that failed. The two wrong answers are not
 * symmetric:
 *
 *  - a wrong `inert` (we decide the camera owns none of the rule's zones when
 *    it actually owns one) turns a scoped rule into a whole-frame rule and
 *    FIRES a notification the operator deliberately excluded;
 *  - a wrong `unchanged` keeps exactly today's behaviour, which the operator
 *    has already been living with.
 *
 * So `inert` requires the lookup to POSITIVELY answer for the device — an
 * answer it could not produce (`undefined`) yields `unchanged`, never a pass.
 * This is the same shape as D49's doorbell: the destructive direction needs a
 * read that actually succeeded, and an absent read changes nothing.
 *
 * Kept pure and dependency-free on purpose: the summaries collector (task #35)
 * scopes the same ids against the same ownership and must not re-derive this.
 */

/**
 * The zone ids a camera owns, or `undefined` when nobody could answer for it.
 *
 * `[]` is a real answer ("this camera has no zones") and is NOT the same as
 * `undefined` ("we do not know") — the whole fail-closed policy above lives in
 * that distinction, so a lookup that cannot tell them apart must return
 * `undefined`.
 */
export type NcZoneOwnerLookup = (deviceId: number) => readonly string[] | undefined

/** What the caller should evaluate for this camera. */
export type NcZoneScope =
  /** Evaluate the rule's full id list, exactly as before (nothing to scope, or
   *  ownership unknown). */
  | { readonly kind: 'unchanged' }
  /** This camera owns NONE of the rule's zones — the condition does not apply
   *  to it and the subject matches whole-frame. */
  | { readonly kind: 'inert' }
  /** Evaluate against `ids` — the subset of the rule's zones this camera owns.
   *  Non-empty by construction. */
  | { readonly kind: 'scoped'; readonly ids: readonly string[] }

const UNCHANGED: NcZoneScope = { kind: 'unchanged' }
const INERT: NcZoneScope = { kind: 'inert' }

/**
 * Narrow a rule's zone id list to the zones OWNED by one camera.
 *
 * Applies unchanged to both quantifiers: `match: 'all'` means "every one of the
 * zones I picked FOR THIS CAMERA was visited", so a two-camera rule with one
 * zone each is satisfiable, which a flat `all` never was.
 */
export function scopeZoneIdsToDevice(
  ids: readonly string[],
  deviceId: number,
  owner: NcZoneOwnerLookup | undefined,
): NcZoneScope {
  if (ids.length === 0) return UNCHANGED
  const owned = owner?.(deviceId)
  if (owned === undefined) return UNCHANGED
  const ownedIds = new Set(owned)
  const mine = ids.filter((id) => ownedIds.has(id))
  if (mine.length === 0) return INERT
  if (mine.length === ids.length) return UNCHANGED
  return { kind: 'scoped', ids: mine }
}

/** One rule's zone list, as {@link scopeZoneIdsForRule} needs to see it. */
export interface NcZoneScopeInput {
  /** `conditions.zones.ids`. */
  readonly ids: readonly string[]
  /**
   * `conditions.devices` — the cameras the operator NAMED on this rule.
   * Absent/empty means "every camera", which is the case this scoping refuses
   * to touch; see below.
   */
  readonly deviceScope: readonly number[] | undefined
  /** The subject's camera. */
  readonly deviceId: number
}

/**
 * The rule-level entry point: scope this rule's zones to this camera.
 *
 * ── One semantic for scoped AND unscoped rules (operator, 2026-08-13) ───────
 *
 * "No zones set on a camera means everywhere." A zone in the list narrows ONLY
 * the camera that owns it; every other camera the rule reaches — named or
 * reached because the rule names no camera at all — matches whole-frame. The
 * first cut kept unscoped rules flat to avoid widening "notify me when someone
 * is in the driveway" into an all-camera rule; the operator overruled it: an
 * unscoped rule already IS an all-camera rule, and the zone is a per-camera
 * narrowing, not a rule-wide one. Scoping a rule to cameras remains the way to
 * limit where it fires.
 */
export function scopeZoneIdsForRule(
  input: NcZoneScopeInput,
  owner: NcZoneOwnerLookup | undefined,
): NcZoneScope {
  return scopeZoneIdsToDevice(input.ids, input.deviceId, owner)
}
