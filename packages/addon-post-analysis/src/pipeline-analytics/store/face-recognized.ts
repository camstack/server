/**
 * `recognized` — the denormalised "this face carries an identity" bit.
 *
 * The `recognized` and `identified` gallery views are "has an identity", and a
 * records `where` has no `IS NOT NULL`: asked as `whereNot { recognizedIdentityId:
 * null }` it can only be a residual predicate over a wider page, i.e. rows read
 * and then thrown away. A boolean the index can serve answers it as a range.
 *
 * It is derived in ONE place — the faces ledger's write door — from whatever a
 * write says about `recognizedIdentityId`, so no caller (assign, unassign,
 * recognise, rescore, merge, the identity-delete cascade, a generic patch) can
 * set the identity and forget the bit.
 */
import type { EventLedgerBodyDerivation } from './event-ledger-collection.js'

/** A non-empty string identity is a recognition; absent, `null` and `''` are not. */
export function isRecognizedIdentity(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

/**
 * - a whole row (`put`): `recognized` always follows `recognizedIdentityId`;
 * - a merge patch (RFC 7396): `recognized` is written exactly when the patch
 *   names `recognizedIdentityId` — and `null` there is a write of
 *   `recognized: false`, never a dropped key.
 */
export const deriveFaceRecognized: EventLedgerBodyDerivation = (body, mode) => {
  if (mode === 'patch' && !('recognizedIdentityId' in body)) return body
  return { ...body, recognized: isRecognizedIdentity(body['recognizedIdentityId']) }
}
